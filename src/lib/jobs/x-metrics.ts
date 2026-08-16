/**
 * Own-account X metrics via the official v2 API — replaces the scrape path for
 * X only (LinkedIn and Instagram have no personal-analytics API and stay on
 * the social-sync skill).
 *
 * Two reads per run: users/me for the follower counts, and the own-tweets
 * timeline for per-post public_metrics. Reads are the scarce resource on X's
 * free tier (writes are generous, reads are metered per month), so this runs
 * weekly and takes exactly those two calls. A 402/403 means the app's tier
 * doesn't include the read — reported as "skipped" with the reason rather
 * than "failed", because nothing is broken that a retry would fix.
 *
 * Rows go through ingestSocialBatch with source="api" so they're
 * indistinguishable from GitHub's in every downstream query and are left
 * alone by revert-social (scoped to source='scrape').
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { socialPosts } from "@/db/schema";
import { ingestSocialBatch, type SocialBatch } from "@/lib/social-ingest";
import { xGet } from "@/lib/x-api";
import type { JobResult } from "./registry";

/** Posts older than this stop moving; no point capturing them weekly. */
const POST_WINDOW_DAYS = 60;

type Me = {
  data: {
    id: string;
    username: string;
    public_metrics?: {
      followers_count: number;
      following_count: number;
      tweet_count: number;
      listed_count: number;
    };
  };
};

type Tweets = {
  data?: {
    id: string;
    text: string;
    created_at?: string;
    public_metrics?: {
      retweet_count: number;
      reply_count: number;
      like_count: number;
      quote_count: number;
      bookmark_count?: number;
      impression_count?: number;
    };
  }[];
};

export async function xMetricsJob(): Promise<JobResult> {
  const me = await xGet<Me>("/users/me", { "user.fields": "public_metrics" });
  if (!me.ok) {
    if (me.reason === "unconfigured") {
      return { status: "skipped", message: "X API keys not set — add them in Setup" };
    }
    if (me.reason === "forbidden" || me.reason === "rate_limited") {
      return { status: "skipped", message: me.error };
    }
    throw new Error(me.error);
  }
  const { id, username, public_metrics: pm } = me.data.data;

  const tweets = await xGet<Tweets>(`/users/${id}/tweets`, {
    max_results: "100",
    exclude: "replies,retweets",
    "tweet.fields": "public_metrics,created_at",
  });
  // The account row is worth keeping even if the timeline read isn't allowed
  // on this tier — followers alone feed the /social sparkline.
  const timelineNote = tweets.ok ? null : tweets.error;

  // Posts made in-app are stored as x.com/i/status/<id>; the timeline gives
  // us the numeric id, so match on that tail and reuse the stored URL, else
  // fall back to the canonical /<handle>/status/<id>. Exact-URL is the join
  // key in social_post_metrics, so this is what links metrics to drafts.
  const known = await getDb()
    .select({ postUrl: socialPosts.postUrl })
    .from(socialPosts)
    .where(and(eq(socialPosts.platform, "x"), isNotNull(socialPosts.postUrl)));
  const knownById = new Map<string, string>();
  for (const k of known) {
    const m = k.postUrl?.match(/\/status\/(\d+)/);
    if (m) knownById.set(m[1], k.postUrl!);
  }

  const cutoff = Date.now() - POST_WINDOW_DAYS * 86_400_000;
  const posts: SocialBatch["posts"] = [];
  for (const t of tweets.ok ? (tweets.data.data ?? []) : []) {
    const created = t.created_at ? Date.parse(t.created_at) : NaN;
    const inWindow = !Number.isFinite(created) || created >= cutoff;
    if (!inWindow && !knownById.has(t.id)) continue;
    const m = t.public_metrics;
    posts.push({
      platform: "x",
      postUrl: knownById.get(t.id) ?? `https://x.com/${username}/status/${t.id}`,
      postedAt: t.created_at ?? null,
      excerpt: t.text.slice(0, 100),
      impressions: m?.impression_count ?? null,
      likes: m?.like_count ?? null,
      comments: m?.reply_count ?? null,
      reposts: m ? m.retweet_count + m.quote_count : null,
      bookmarks: m?.bookmark_count ?? null,
    });
  }

  const batch: SocialBatch = {
    capturedAt: new Date().toISOString(),
    accounts: [
      {
        platform: "x",
        followers: pm?.followers_count ?? null,
        following: pm?.following_count ?? null,
        postCount: pm?.tweet_count ?? null,
        extra: pm ? { listed: pm.listed_count } : null,
      },
    ],
    posts,
  };
  const s = await ingestSocialBatch(batch, { source: "api" });
  if (!s.ok) throw new Error(s.error ?? "ingest failed");

  return {
    status: "ok",
    message:
      `@${username} · ${pm?.followers_count ?? "?"} followers · ${posts.length} posts` +
      (timelineNote ? ` · timeline: ${timelineNote}` : ""),
    summary: {
      username,
      followers: pm?.followers_count ?? null,
      posts: posts.length,
      matchedPosts: s.matchedPosts,
      timelineNote,
    },
  };
}
