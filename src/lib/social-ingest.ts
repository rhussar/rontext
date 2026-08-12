/**
 * Imports a social-sync batch (own-account analytics scraped from LinkedIn,
 * X and Instagram by the social-sync skill) into the metrics tables.
 *
 * Pure lib (not "use server"), called by scripts/ingest-social.ts — same
 * three-stage pipeline as linkedin-ingest.ts: scrape → reviewable JSON batch
 * on disk → CLI import → provenance-scoped revert (scripts/revert-social.ts).
 *
 * Both metric tables are append-only: a batch inserts new capture rows, never
 * updates old ones. Importing the same file twice therefore creates a second
 * capture of the same numbers — harmless for deltas (delta = 0) but noisy;
 * the skill writes one batch per run and imports it once.
 */

import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  socialAccountMetrics,
  socialPostMetrics,
  socialPosts,
  socialSyncRuns,
  SOCIAL_PLATFORMS,
  SOCIAL_POST_PLATFORMS,
  type SocialPlatform,
} from "@/db/schema";
import { normalizePostUrl } from "@/lib/social";

const countField = z.number().int().nonnegative().nullish();

const accountSchema = z.object({
  platform: z.enum(SOCIAL_PLATFORMS),
  followers: countField,
  following: countField,
  postCount: countField,
  profileViews: countField,
  impressions: countField,
  extra: z.record(z.string(), z.number()).nullish(),
});

const postSchema = z.object({
  platform: z.enum(SOCIAL_POST_PLATFORMS),
  postUrl: z.string().url(),
  /** ISO date or datetime, as scraped ("2026-08-08" is fine). */
  postedAt: z.string().nullish(),
  excerpt: z.string().max(300).nullish(),
  impressions: countField,
  likes: countField,
  comments: countField,
  reposts: countField,
  bookmarks: countField,
});

export const batchSchema = z.object({
  capturedAt: z.string().datetime({ offset: true }).nullish(),
  accounts: z.array(accountSchema).default([]),
  posts: z.array(postSchema).default([]),
});

export type SocialBatch = z.infer<typeof batchSchema>;

export type IngestSummary = {
  ok: boolean;
  accountRows: number;
  postRows: number;
  /** Post metric rows whose URL matched a social_posts row. */
  matchedPosts: number;
  platforms: SocialPlatform[];
  dryRun: boolean;
  error?: string;
};

export async function ingestSocialBatch(
  raw: unknown,
  opts: { dryRun?: boolean } = {},
): Promise<IngestSummary> {
  const parsed = batchSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false, accountRows: 0, postRows: 0, matchedPosts: 0,
      platforms: [], dryRun: !!opts.dryRun,
      error: `Batch failed validation: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const batch = parsed.data;
  const capturedAt = batch.capturedAt ? new Date(batch.capturedAt) : new Date();

  const posts = batch.posts.map((p) => ({
    ...p,
    postUrl: normalizePostUrl(p.postUrl)!,
  }));

  const db = getDb();

  // Resolve postId by URL in one query — posts made in the app get linked,
  // everything else stays a tracked-external row (postId null).
  const urls = [...new Set(posts.map((p) => p.postUrl))];
  const known = urls.length
    ? await db
        .select({ id: socialPosts.id, postUrl: socialPosts.postUrl })
        .from(socialPosts)
        .where(inArray(socialPosts.postUrl, urls))
    : [];
  const idByUrl = new Map(known.map((k) => [k.postUrl!, k.id]));

  const platforms = [
    ...new Set([
      ...batch.accounts.map((a) => a.platform),
      ...posts.map((p) => p.platform),
    ]),
  ];

  const summary: IngestSummary = {
    ok: true,
    accountRows: batch.accounts.length,
    postRows: posts.length,
    matchedPosts: posts.filter((p) => idByUrl.has(p.postUrl)).length,
    platforms,
    dryRun: !!opts.dryRun,
  };
  if (opts.dryRun) return summary;

  if (batch.accounts.length) {
    await db.insert(socialAccountMetrics).values(
      batch.accounts.map((a) => ({
        platform: a.platform,
        capturedAt,
        followers: a.followers ?? null,
        following: a.following ?? null,
        postCount: a.postCount ?? null,
        profileViews: a.profileViews ?? null,
        impressions: a.impressions ?? null,
        extra: a.extra ?? null,
        source: "scrape" as const,
      })),
    );
  }

  if (posts.length) {
    await db.insert(socialPostMetrics).values(
      posts.map((p) => ({
        platform: p.platform,
        postUrl: p.postUrl,
        postId: idByUrl.get(p.postUrl) ?? null,
        postedAt: p.postedAt ? new Date(p.postedAt) : null,
        excerpt: p.excerpt ?? null,
        capturedAt,
        impressions: p.impressions ?? null,
        likes: p.likes ?? null,
        comments: p.comments ?? null,
        reposts: p.reposts ?? null,
        bookmarks: p.bookmarks ?? null,
        source: "scrape" as const,
      })),
    );
  }

  for (const platform of platforms) {
    await db.insert(socialSyncRuns).values({
      platform,
      accountRows: batch.accounts.filter((a) => a.platform === platform).length,
      postRows: posts.filter((p) => p.platform === platform).length,
    });
  }

  return summary;
}

export type RevertSummary = {
  ok: true;
  accountRows: number;
  postRows: number;
  syncRuns: number;
  dryRun: boolean;
};

/**
 * Deletes scraped metric rows (and their run log). Provenance-scoped: rows
 * with source='api' — the GitHub ingest — are never touched, mirroring how
 * revert-linkedin.ts leaves vCard photos alone.
 */
export async function revertSocialScrapes(opts: {
  platform?: SocialPlatform;
  dryRun?: boolean;
}): Promise<RevertSummary> {
  const db = getDb();

  const accountWhere = opts.platform
    ? [eq(socialAccountMetrics.source, "scrape" as const), eq(socialAccountMetrics.platform, opts.platform)]
    : [eq(socialAccountMetrics.source, "scrape" as const)];
  const postWhere = opts.platform
    ? [eq(socialPostMetrics.source, "scrape" as const), eq(socialPostMetrics.platform, opts.platform as (typeof SOCIAL_POST_PLATFORMS)[number])]
    : [eq(socialPostMetrics.source, "scrape" as const)];

  const accounts = await db
    .select({ id: socialAccountMetrics.id })
    .from(socialAccountMetrics)
    .where(and(...accountWhere));
  const posts = await db
    .select({ id: socialPostMetrics.id })
    .from(socialPostMetrics)
    .where(and(...postWhere));
  // Sync runs carry no source column: scrape runs are exactly the non-github
  // ones, except a --platform github revert, which must not touch them at all.
  const runs =
    opts.platform === "github"
      ? []
      : await db
          .select({ id: socialSyncRuns.id })
          .from(socialSyncRuns)
          .where(
            opts.platform
              ? eq(socialSyncRuns.platform, opts.platform)
              : inArray(socialSyncRuns.platform, ["linkedin", "x", "instagram"]),
          );

  const summary: RevertSummary = {
    ok: true,
    accountRows: accounts.length,
    postRows: posts.length,
    syncRuns: runs.length,
    dryRun: !!opts.dryRun,
  };
  if (opts.dryRun) return summary;

  if (accounts.length)
    await db.delete(socialAccountMetrics).where(inArray(socialAccountMetrics.id, accounts.map((r) => r.id)));
  if (posts.length)
    await db.delete(socialPostMetrics).where(inArray(socialPostMetrics.id, posts.map((r) => r.id)));
  if (runs.length)
    await db.delete(socialSyncRuns).where(inArray(socialSyncRuns.id, runs.map((r) => r.id)));

  return summary;
}
