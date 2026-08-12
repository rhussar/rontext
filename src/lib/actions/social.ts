"use server";

import { desc, eq, gte, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  appState,
  socialAccountMetrics,
  socialPostMedia,
  socialPostMetrics,
  socialPosts,
  type DraftSource,
  type MetricSource,
  type SocialPlatform,
  type SocialPost,
  type SocialPostPlatform,
} from "@/db/schema";
import { generateSocialPostFor } from "@/lib/social-post-ai";
import { githubViewsSeries } from "@/lib/github-ingest";
import {
  normalizePostUrl,
  PROFILE_PLATFORMS,
  type PlatformProfile,
  type ProfilePlatform,
} from "@/lib/social";
import { postTweet } from "@/lib/x-api";
import { imageFromFile } from "@/lib/image-import";

/** Duplicated per action file — "use server" modules can only export async fns. */
function revalidateAll() {
  revalidatePath("/", "layout");
}

/**
 * AI provenance handed back on save, mirroring drafts' DraftOrigin. Present
 * iff the text started as a generation — it's the only wire the provenance
 * model has, since generated text lands in a textarea before it's a row.
 */
export type PostOrigin = {
  generatedBody: string;
  model: string;
  promptVersion: number;
};

export type GenerateSocialPostResult =
  | { ok: true; body: string; origin: PostOrigin }
  | { ok: false; error: string };

/**
 * Writes a first draft from an owner-typed topic. Saves nothing — the caller
 * puts this in the composer and the owner decides whether it becomes a row.
 * No `revalidateAll()` on purpose: this is the one export here that doesn't
 * mutate, same as generateDraft in drafts.ts.
 */
export async function generateSocialPostAction(
  platform: SocialPostPlatform,
  topic: string,
): Promise<GenerateSocialPostResult> {
  const result = await generateSocialPostFor(platform, topic);
  if (!result.ok) return result;
  return {
    ok: true,
    body: result.body,
    origin: {
      generatedBody: result.body,
      model: result.model,
      promptVersion: result.promptVersion,
    },
  };
}

export async function createSocialPost(
  platform: SocialPostPlatform,
  body: string,
  origin?: PostOrigin,
): Promise<SocialPost> {
  const db = getDb();
  const [post] = await db
    .insert(socialPosts)
    .values({
      platform,
      body: body.trim(),
      source: origin ? "ai" : "manual",
      // Trimmed to match `body`, so an unedited generation compares equal.
      generatedBody: origin?.generatedBody.trim() ?? null,
      model: origin?.model ?? null,
      promptVersion: origin?.promptVersion ?? null,
    })
    .returning();
  revalidateAll();
  return post;
}

export async function updateSocialPost(
  id: number,
  patch: { platform?: SocialPostPlatform; body?: string; postUrl?: string | null },
): Promise<void> {
  const next: Partial<typeof socialPosts.$inferInsert> = { updatedAt: new Date() };
  if (patch.platform !== undefined) next.platform = patch.platform;
  if (patch.body !== undefined) next.body = patch.body.trim();
  if (patch.postUrl !== undefined)
    next.postUrl = patch.postUrl ? normalizePostUrl(patch.postUrl) : null;
  await getDb().update(socialPosts).set(next).where(eq(socialPosts.id, id));
  revalidateAll();
}

/**
 * Marks published. When a permalink is supplied it also adopts any metric
 * rows the scraper already wrote for that URL (a post can be tracked before
 * it's linked — the scraper only knows URLs).
 */
export async function markPosted(id: number, postUrl?: string): Promise<void> {
  const db = getDb();
  const url = postUrl ? normalizePostUrl(postUrl) : null;
  await db
    .update(socialPosts)
    .set({ postedAt: new Date(), postUrl: url, updatedAt: new Date() })
    .where(eq(socialPosts.id, id));
  if (url) {
    await db
      .update(socialPostMetrics)
      .set({ postId: id })
      .where(eq(socialPostMetrics.postUrl, url));
  }
  revalidateAll();
}

export type PostToXResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Publish an X draft via the API. The handoff button stays as the fallback —
 * this is the one platform where real API posting is cheap (free tier writes).
 */
export async function postToXAction(id: number): Promise<PostToXResult> {
  const db = getDb();
  const [post] = await db
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.id, id))
    .limit(1);
  if (!post) return { ok: false, error: "That post no longer exists." };
  if (post.platform !== "x")
    return { ok: false, error: "Only X posts can be published via the API." };
  if (post.postedAt) return { ok: false, error: "Already posted." };
  if (!post.body.trim()) return { ok: false, error: "The post is empty." };

  // Refuse rather than silently publish without the images — media upload is
  // a separate v1.1-era endpoint this integration deliberately doesn't do.
  const [hasMedia] = await db
    .select({ id: socialPostMedia.id })
    .from(socialPostMedia)
    .where(eq(socialPostMedia.postId, id))
    .limit(1);
  if (hasMedia) {
    return {
      ok: false,
      error:
        "This post has images — the API path is text-only. Use the handoff and attach them in X's composer.",
    };
  }

  const result = await postTweet(post.body);
  if (!result.ok) return result;

  await db
    .update(socialPosts)
    .set({
      postedAt: new Date(),
      postUrl: normalizePostUrl(result.url),
      externalId: result.id,
      updatedAt: new Date(),
    })
    .where(eq(socialPosts.id, id));
  revalidateAll();
  return { ok: true, url: result.url };
}

/** Mis-click affordance, not an undo — keeps postUrl so re-marking is one click. */
export async function unmarkPosted(id: number): Promise<void> {
  await getDb()
    .update(socialPosts)
    .set({ postedAt: null, updatedAt: new Date() })
    .where(eq(socialPosts.id, id));
  revalidateAll();
}

export async function deleteSocialPost(id: number): Promise<void> {
  await getDb().delete(socialPosts).where(eq(socialPosts.id, id));
  revalidateAll();
}

/** Enough to render a preview <img> — never the bytes (list queries stay light). */
export type PostMediaRef = {
  id: number;
  width: number | null;
  height: number | null;
};

export type SocialPostRow = {
  id: number;
  platform: SocialPostPlatform;
  body: string;
  source: DraftSource;
  /** ISO — a Date doesn't cross into a client component's props cleanly. */
  postedAt: string | null;
  postUrl: string | null;
  updatedAt: string;
  media: PostMediaRef[];
};

export async function listSocialPosts(): Promise<SocialPostRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: socialPosts.id,
      platform: socialPosts.platform,
      body: socialPosts.body,
      source: socialPosts.source,
      postedAt: socialPosts.postedAt,
      postUrl: socialPosts.postUrl,
      updatedAt: socialPosts.updatedAt,
    })
    .from(socialPosts)
    .orderBy(desc(socialPosts.updatedAt))
    .limit(200);

  const media = rows.length
    ? await db
        .select({
          id: socialPostMedia.id,
          postId: socialPostMedia.postId,
          width: socialPostMedia.width,
          height: socialPostMedia.height,
        })
        .from(socialPostMedia)
        .where(inArray(socialPostMedia.postId, rows.map((r) => r.id)))
        .orderBy(socialPostMedia.position, socialPostMedia.id)
    : [];
  const mediaByPost = new Map<number, PostMediaRef[]>();
  for (const m of media) {
    const list = mediaByPost.get(m.postId) ?? [];
    list.push({ id: m.id, width: m.width, height: m.height });
    mediaByPost.set(m.postId, list);
  }

  // Drafts first, each section newest-first. One pass, order is already right
  // within each partition because the query sorted by updatedAt.
  const open = rows.filter((r) => r.postedAt === null);
  const posted = rows.filter((r) => r.postedAt !== null);
  return [...open, ...posted].map((r) => ({
    ...r,
    postedAt: r.postedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
    media: mediaByPost.get(r.id) ?? [],
  }));
}

/** X shows at most 4 images per post — the strictest of the three, so the cap. */
const MAX_MEDIA_PER_POST = 4;
/** The composer downscales client-side first; this is the backstop. */
const MEDIA_MAX_BYTES = 1_500_000;
const MEDIA_LIMIT_LABEL = "1.5MB";

export type AddMediaResult =
  | { ok: true; media: PostMediaRef }
  | { ok: false; error: string };

export async function addSocialPostMedia(
  postId: number,
  formData: FormData,
): Promise<AddMediaResult> {
  const db = getDb();
  const [post] = await db
    .select({ id: socialPosts.id })
    .from(socialPosts)
    .where(eq(socialPosts.id, postId))
    .limit(1);
  if (!post) return { ok: false, error: "That post no longer exists." };

  const existing = await db
    .select({ position: socialPostMedia.position })
    .from(socialPostMedia)
    .where(eq(socialPostMedia.postId, postId));
  if (existing.length >= MAX_MEDIA_PER_POST) {
    return { ok: false, error: `At most ${MAX_MEDIA_PER_POST} images per post.` };
  }

  const intake = await imageFromFile(
    formData.get("file"),
    MEDIA_MAX_BYTES,
    MEDIA_LIMIT_LABEL,
  );
  if (!intake.ok) return intake;

  const width = Number(formData.get("width"));
  const height = Number(formData.get("height"));

  const [row] = await db
    .insert(socialPostMedia)
    .values({
      postId,
      position: existing.length
        ? Math.max(...existing.map((e) => e.position)) + 1
        : 0,
      data: intake.data,
      contentType: intake.contentType,
      width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
      height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    })
    .returning({
      id: socialPostMedia.id,
      width: socialPostMedia.width,
      height: socialPostMedia.height,
    });
  revalidateAll();
  return { ok: true, media: row };
}

export async function removeSocialPostMedia(mediaId: number): Promise<void> {
  await getDb().delete(socialPostMedia).where(eq(socialPostMedia.id, mediaId));
  revalidateAll();
}

export type AccountSnapshot = {
  capturedAt: string;
  followers: number | null;
  following: number | null;
  postCount: number | null;
  profileViews: number | null;
  impressions: number | null;
  extra: Record<string, number> | null;
};

export type PlatformSnapshot = {
  platform: SocialPlatform;
  latest: AccountSnapshot | null;
  /** The capture before `latest`, for the delta. */
  previous: AccountSnapshot | null;
  /** Oldest-first follower counts for the sparkline. */
  series: { capturedAt: string; followers: number | null }[];
};

const OVERVIEW_DAYS = 90;

/**
 * Captures are manual and at most daily, so ~90 days per platform is a few
 * hundred rows at worst — grouping in JS beats a DISTINCT ON round-trip per
 * platform here.
 */
export async function getSocialOverview(): Promise<PlatformSnapshot[]> {
  const since = new Date(Date.now() - OVERVIEW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await getDb()
    .select()
    .from(socialAccountMetrics)
    .where(gte(socialAccountMetrics.capturedAt, since))
    .orderBy(desc(socialAccountMetrics.capturedAt));

  const platforms: SocialPlatform[] = ["linkedin", "x", "instagram", "github"];
  return platforms.map((platform) => {
    const mine = rows.filter((r) => r.platform === platform);
    const toSnap = (r: (typeof mine)[number]): AccountSnapshot => ({
      capturedAt: r.capturedAt.toISOString(),
      followers: r.followers,
      following: r.following,
      postCount: r.postCount,
      profileViews: r.profileViews,
      impressions: r.impressions,
      extra: (r.extra as Record<string, number> | null) ?? null,
    });
    return {
      platform,
      latest: mine[0] ? toSnap(mine[0]) : null,
      previous: mine[1] ? toSnap(mine[1]) : null,
      series: mine
        .slice()
        .reverse()
        .map((r) => ({
          capturedAt: r.capturedAt.toISOString(),
          followers: r.followers,
        })),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Per-platform social profiles
 *
 * One identity record per platform (photo, name, handle, bio), stored as a
 * JSON app_state row per platform rather than in Settings — settings ride
 * along on every page load, and avatar data URLs don't belong there. The
 * previews on /social read these; YouTube is stored for when the app grows
 * a YouTube feature but is otherwise just identity storage today.
 * ------------------------------------------------------------------ */

const EMPTY_PROFILE: PlatformProfile = { name: "", handle: "", bio: "", avatar: null };
const profileKey = (p: ProfilePlatform) => `socialProfile:${p}`;
const AVATAR_MAX_BYTES = 200_000;

/** Keys the pre-per-platform version wrote; read as seed values only. */
const LEGACY_KEYS = [
  "socialDisplayName",
  "socialXHandle",
  "socialIgHandle",
  "socialHeadline",
  "socialAvatar",
] as const;

function parseProfile(raw: string | undefined): PlatformProfile | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PlatformProfile>;
    return {
      name: typeof p.name === "string" ? p.name : "",
      handle: typeof p.handle === "string" ? p.handle : "",
      bio: typeof p.bio === "string" ? p.bio : "",
      avatar: typeof p.avatar === "string" ? p.avatar : null,
    };
  } catch {
    return null;
  }
}

export async function getSocialProfiles(): Promise<
  Record<ProfilePlatform, PlatformProfile>
> {
  const rows = await getDb()
    .select({ key: appState.key, value: appState.value })
    .from(appState)
    .where(
      inArray(appState.key, [
        ...PROFILE_PLATFORMS.map(profileKey),
        ...LEGACY_KEYS,
      ]),
    );
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  // Seed from the flat fields the first version stored, so nothing typed in
  // before the per-platform split silently vanishes. A platform's own record
  // always wins once one has been saved.
  const legacy = {
    name: byKey.get("socialDisplayName") ?? "",
    headline: byKey.get("socialHeadline") ?? "",
    xHandle: byKey.get("socialXHandle") ?? "",
    igHandle: byKey.get("socialIgHandle") ?? "",
    avatar: byKey.get("socialAvatar") ?? null,
  };
  const seeds: Record<ProfilePlatform, PlatformProfile> = {
    linkedin: { name: legacy.name, handle: "", bio: legacy.headline, avatar: legacy.avatar },
    x: { name: legacy.name, handle: legacy.xHandle, bio: "", avatar: legacy.avatar },
    instagram: { name: legacy.name, handle: legacy.igHandle, bio: "", avatar: legacy.avatar },
    youtube: { ...EMPTY_PROFILE, name: legacy.name },
  };

  return Object.fromEntries(
    PROFILE_PLATFORMS.map((p) => [
      p,
      parseProfile(byKey.get(profileKey(p))) ?? seeds[p],
    ]),
  ) as Record<ProfilePlatform, PlatformProfile>;
}

/**
 * Saves one platform's record. Text fields arrive as form fields; the photo
 * as an optional `file` (already downscaled client-side), with `removeAvatar`
 * clearing it. Absent text fields keep their stored value, so the dialog can
 * submit only what changed.
 */
export async function saveSocialProfile(
  platform: ProfilePlatform,
  formData: FormData,
): Promise<{ ok: true; profile: PlatformProfile } | { ok: false; error: string }> {
  const current = (await getSocialProfiles())[platform];

  const text = (field: string): string | null => {
    const v = formData.get(field);
    return typeof v === "string" ? v.trim() : null;
  };

  let avatar = current.avatar;
  if (formData.get("removeAvatar") === "1") {
    avatar = null;
  } else if (formData.get("file")) {
    const intake = await imageFromFile(formData.get("file"), AVATAR_MAX_BYTES, "200KB");
    if (!intake.ok) return intake;
    avatar = `data:${intake.contentType};base64,${intake.data}`;
  }

  const profile: PlatformProfile = {
    name: text("name") ?? current.name,
    handle: (text("handle") ?? current.handle).replace(/^@/, ""),
    bio: text("bio") ?? current.bio,
    avatar,
  };

  const value = JSON.stringify(profile);
  await getDb()
    .insert(appState)
    .values({ key: profileKey(platform), value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appState.key,
      set: { value, updatedAt: new Date() },
    });
  revalidateAll();
  return { ok: true, profile };
}

export type GithubTrafficDay = { day: string; views: number; uniqueViews: number };

/** Daily repo views summed across repos, for the GitHub tile's sparkline. */
export async function getGithubTraffic(): Promise<GithubTrafficDay[]> {
  return githubViewsSeries(30);
}

export type PostMetricPoint = {
  capturedAt: string;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  reposts: number | null;
  bookmarks: number | null;
  source: MetricSource;
};

export async function getPostMetrics(postUrl: string): Promise<PostMetricPoint[]> {
  const url = normalizePostUrl(postUrl);
  if (!url) return [];
  const rows = await getDb()
    .select()
    .from(socialPostMetrics)
    .where(eq(socialPostMetrics.postUrl, url))
    .orderBy(socialPostMetrics.capturedAt);
  return rows.map((r) => ({
    capturedAt: r.capturedAt.toISOString(),
    impressions: r.impressions,
    likes: r.likes,
    comments: r.comments,
    reposts: r.reposts,
    bookmarks: r.bookmarks,
    source: r.source,
  }));
}

export type TrackedPost = {
  platform: SocialPostPlatform;
  postUrl: string;
  /** Null for posts made outside the app. */
  postId: number | null;
  postedAt: string | null;
  excerpt: string | null;
  capturedAt: string;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  reposts: number | null;
};

/** Latest snapshot per tracked URL, newest posts first. */
export async function listTrackedPosts(): Promise<TrackedPost[]> {
  // DISTINCT ON is the natural fit; drizzle's API doesn't expose it, so the
  // window-function spelling keeps this one round-trip.
  const rows = await getDb()
    .select({
      platform: socialPostMetrics.platform,
      postUrl: socialPostMetrics.postUrl,
      postId: socialPostMetrics.postId,
      postedAt: socialPostMetrics.postedAt,
      excerpt: socialPostMetrics.excerpt,
      capturedAt: socialPostMetrics.capturedAt,
      impressions: socialPostMetrics.impressions,
      likes: socialPostMetrics.likes,
      comments: socialPostMetrics.comments,
      reposts: socialPostMetrics.reposts,
      rank: sql<number>`row_number() over (partition by ${socialPostMetrics.postUrl} order by ${socialPostMetrics.capturedAt} desc)`.as(
        "rank",
      ),
    })
    .from(socialPostMetrics)
    .orderBy(desc(socialPostMetrics.postedAt), desc(socialPostMetrics.capturedAt))
    .limit(500);

  return rows
    .filter((r) => Number(r.rank) === 1)
    .map((r) => ({
      platform: r.platform,
      postUrl: r.postUrl,
      postId: r.postId,
      postedAt: r.postedAt?.toISOString() ?? null,
      excerpt: r.excerpt,
      capturedAt: r.capturedAt.toISOString(),
      impressions: r.impressions,
      likes: r.likes,
      comments: r.comments,
      reposts: r.reposts,
    }));
}
