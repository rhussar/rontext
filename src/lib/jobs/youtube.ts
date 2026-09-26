/**
 * Own-channel YouTube stats via the Data API v3 — public numbers only
 * (subscribers, total views, video count, per-video views/likes/comments), so
 * a plain API key is enough; no OAuth. Watch time and impressions live in the
 * Analytics API, which needs OAuth and isn't worth the consent flow yet.
 *
 * The channel is the YouTube handle from Settings → General (the profile
 * record), so there's nothing extra to configure beyond the key. Cost is ~3
 * quota units per run against a 10,000/day free quota.
 *
 * Videos don't fit social_post_metrics (YouTube isn't a post platform), so the
 * recent-uploads roll-up goes in the account row's `extra`, like GitHub's stars.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appState } from "@/db/schema";
import { ingestSocialBatch } from "@/lib/social-ingest";
import { getSecret } from "@/lib/secrets";
import type { JobResult } from "./registry";

const API = "https://www.googleapis.com/youtube/v3";
/** Uploads roll-up window — enough to see how the latest videos are doing. */
const RECENT_VIDEOS = 10;

async function ytGet<T>(path: string, params: Record<string, string>, key: string): Promise<T> {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // The key goes in a header, not the query, so it can't leak via error URLs.
  const res = await fetch(url, { headers: { "x-goog-api-key": key } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(`YouTube API ${res.status}: ${body?.error?.message ?? res.statusText}`);
  }
  return res.json() as Promise<T>;
}

type Channels = {
  items?: {
    id: string;
    snippet: { title: string };
    statistics: {
      subscriberCount?: string;
      viewCount?: string;
      videoCount?: string;
      hiddenSubscriberCount?: boolean;
    };
    contentDetails: { relatedPlaylists: { uploads: string } };
  }[];
};
type PlaylistItems = { items?: { contentDetails: { videoId: string } }[] };
type Videos = {
  items?: { statistics: { viewCount?: string; likeCount?: string; commentCount?: string } }[];
};

const num = (v: string | undefined) => (v === undefined ? 0 : Number(v));

async function channelHandle(): Promise<string | null> {
  const [row] = await getDb()
    .select({ value: appState.value })
    .from(appState)
    .where(eq(appState.key, "socialProfile:youtube"));
  try {
    const handle = (JSON.parse(row?.value ?? "{}") as { handle?: string }).handle?.trim();
    return handle ? handle.replace(/^@/, "") : null;
  } catch {
    return null;
  }
}

export async function youtubeJob(): Promise<JobResult> {
  const key = await getSecret("YOUTUBE_API_KEY");
  if (!key) {
    return { status: "skipped", message: "YOUTUBE_API_KEY not set — add it in Settings → Setup" };
  }
  const handle = await channelHandle();
  if (!handle) {
    return { status: "skipped", message: "No YouTube handle — set it in Settings → General → YouTube" };
  }

  const ch = await ytGet<Channels>(
    "channels",
    { part: "snippet,statistics,contentDetails", forHandle: `@${handle}` },
    key,
  );
  const c = ch.items?.[0];
  if (!c) throw new Error(`No YouTube channel found for @${handle}`);

  const uploads = await ytGet<PlaylistItems>(
    "playlistItems",
    { part: "contentDetails", playlistId: c.contentDetails.relatedPlaylists.uploads, maxResults: String(RECENT_VIDEOS) },
    key,
  );
  const ids = (uploads.items ?? []).map((i) => i.contentDetails.videoId);
  const vids = ids.length
    ? await ytGet<Videos>("videos", { part: "statistics", id: ids.join(",") }, key)
    : { items: [] };
  const recent = (vids.items ?? []).reduce(
    (a, v) => ({
      views: a.views + num(v.statistics.viewCount),
      likes: a.likes + num(v.statistics.likeCount),
      comments: a.comments + num(v.statistics.commentCount),
    }),
    { views: 0, likes: 0, comments: 0 },
  );

  const s = c.statistics;
  const subscribers = s.hiddenSubscriberCount ? null : num(s.subscriberCount);
  const totalViews = num(s.viewCount);
  const ingest = await ingestSocialBatch(
    {
      accounts: [
        {
          platform: "youtube",
          followers: subscribers,
          postCount: num(s.videoCount),
          extra: {
            totalViews,
            recentVideos: ids.length,
            recentViews: recent.views,
            recentLikes: recent.likes,
            recentComments: recent.comments,
          },
        },
      ],
    },
    { source: "api" },
  );
  if (!ingest.ok) throw new Error(ingest.error ?? "YouTube ingest failed");

  return {
    status: "ok",
    message: `@${handle} · ${subscribers ?? "hidden"} subscribers · ${totalViews.toLocaleString()} views · ${num(s.videoCount)} videos`,
    summary: { handle, subscribers, totalViews, videos: num(s.videoCount), ...recent },
  };
}
