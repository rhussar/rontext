/**
 * Own-channel YouTube stats, two sources:
 *  - Data API v3 with a plain API key: public numbers (subscribers, total
 *    views, video count, recent-upload views/likes/comments).
 *  - Analytics API v2 over the existing Google grant (yt-analytics.readonly,
 *    added via Reconnect): trailing-28-day watch time, avg view duration,
 *    subscribers gained/lost, shares. Optional — skipped if the grant lacks
 *    the scope. Thumbnail impressions/CTR aren't in any API (Studio only).
 *
 * Analytics uses ids=channel==MINE, i.e. the channel owned by the connected
 * Google account. If the channel lives on a Brand Account, pick it at consent
 * — but then Gmail etc. would read the brand account, so keep the channel on
 * the personal account.
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
import {
  YT_ANALYTICS_API,
  getGoogleCredentials,
  googleGet,
  hasScope,
  refreshAccessToken,
} from "@/lib/google-auth";
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

/** Analytics data lags ~2 days; a 28-day window ending 3 days ago is settled. */
const WINDOW_DAYS = 28;
const LAG_DAYS = 3;

type Report = { columnHeaders?: { name: string }[]; rows?: (number | string)[][] };

/** Trailing-window channel totals, or null if the grant lacks the scope. */
async function analytics(): Promise<Record<string, number> | null> {
  const creds = await getGoogleCredentials();
  if (!creds || !hasScope(creds, "youtube")) return null;
  const token = await refreshAccessToken(creds);
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  const r = await googleGet<Report>(token, `${YT_ANALYTICS_API}/reports`, {
    ids: "channel==MINE",
    startDate: day(LAG_DAYS + WINDOW_DAYS - 1),
    endDate: day(LAG_DAYS),
    metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,shares",
  });
  const row = r.rows?.[0] ?? [];
  const col = (name: string) => {
    const i = r.columnHeaders?.findIndex((h) => h.name === name) ?? -1;
    return i >= 0 ? Number(row[i] ?? 0) : 0;
  };
  return {
    views28d: col("views"),
    watchMinutes28d: col("estimatedMinutesWatched"),
    avgViewSeconds28d: col("averageViewDuration"),
    subsGained28d: col("subscribersGained"),
    subsLost28d: col("subscribersLost"),
    shares28d: col("shares"),
  };
}

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

  // Analytics is a bonus: a failure there is noted, not fatal to the public stats.
  let a: Record<string, number> | null = null;
  let analyticsNote: string | null = null;
  try {
    a = await analytics();
    if (!a) analyticsNote = "watch time off — Reconnect Google to add YouTube Analytics";
  } catch (err) {
    analyticsNote = `analytics failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
  }

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
            ...(a ?? {}),
          },
        },
      ],
    },
    { source: "api" },
  );
  if (!ingest.ok) throw new Error(ingest.error ?? "YouTube ingest failed");

  return {
    status: "ok",
    message:
      `@${handle} · ${subscribers ?? "hidden"} subscribers · ${totalViews.toLocaleString()} views` +
      (a ? ` · ${Math.round(a.watchMinutes28d / 60).toLocaleString()}h watched (28d)` : "") +
      (analyticsNote ? ` · ${analyticsNote}` : ""),
    summary: { handle, subscribers, totalViews, videos: num(s.videoCount), ...recent, ...(a ?? {}), analyticsNote },
  };
}
