/**
 * Own-channel YouTube stats over the existing Google grant — no API key, no
 * handle to configure: both APIs resolve "my channel" from the token.
 *  - Data API v3 (youtube.readonly): subscribers, total views, video count,
 *    recent-upload views/likes/comments.
 *  - Analytics API v2 (yt-analytics.readonly): trailing-28-day watch time,
 *    avg view duration, subscribers gained/lost, shares. Thumbnail
 *    impressions/CTR aren't in any API (Studio only).
 * Both scopes arrive via Settings → Accounts → Google → Add YouTube; both
 * APIs must be enabled in the OAuth client's Cloud project.
 *
 * "My channel" is the channel of the account picked at consent. If the
 * channel lives on a Brand Account, picking it would also point Gmail etc.
 * at the brand account — keep the channel on the personal account.
 *
 * Recent uploads land in social_post_metrics (keyed youtu.be/<id> — a
 * watch?v= URL would lose its id to normalizePostUrl's query strip), with
 * views as impressions. The 90-day daily series goes to app_state
 * (`youtube:daily`), overwritten each run: Analytics can always re-serve it,
 * so there's no history to protect, unlike the append-only metric tables.
 */
import { getDb } from "@/db";
import { appState } from "@/db/schema";
import { ingestSocialBatch, type SocialBatch } from "@/lib/social-ingest";
import {
  YT_ANALYTICS_API,
  YT_DATA_API,
  getGoogleCredentials,
  googleGet,
  hasScope,
  refreshAccessToken,
} from "@/lib/google-auth";
import type { JobResult } from "./registry";

/** Uploads roll-up window — enough to see how the latest videos are doing. */
const RECENT_VIDEOS = 10;
/** Analytics data lags ~2 days; a 28-day window ending 3 days ago is settled. */
const WINDOW_DAYS = 28;
const LAG_DAYS = 3;

type Channels = {
  items?: {
    id: string;
    snippet: { title: string; customUrl?: string };
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
  items?: {
    id: string;
    snippet: { title: string; publishedAt?: string };
    statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
  }[];
};

export const YOUTUBE_DAILY_KEY = "youtube:daily";
const DAILY_DAYS = 90;
type Report = { columnHeaders?: { name: string }[]; rows?: (number | string)[][] };

const num = (v: string | undefined) => (v === undefined ? 0 : Number(v));

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

/** Per-day views/watch time/net subs for the dashboard chart. */
async function dailySeries(token: string): Promise<number> {
  const r = await googleGet<Report>(token, `${YT_ANALYTICS_API}/reports`, {
    ids: "channel==MINE",
    startDate: day(DAILY_DAYS),
    endDate: day(1),
    dimensions: "day",
    sort: "day",
    metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost",
  });
  const idx = (n: string) => r.columnHeaders?.findIndex((h) => h.name === n) ?? -1;
  const [d, v, w, g, l] = ["day", "views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost"].map(idx);
  const rows = (r.rows ?? []).map((row) => ({
    day: String(row[d]),
    views: Number(row[v] ?? 0),
    watchMinutes: Number(row[w] ?? 0),
    netSubs: Number(row[g] ?? 0) - Number(row[l] ?? 0),
  }));
  const value = JSON.stringify(rows);
  await getDb()
    .insert(appState)
    .values({ key: YOUTUBE_DAILY_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt: new Date() } });
  return rows.length;
}

async function analytics(token: string): Promise<Record<string, number>> {
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

export async function youtubeJob(): Promise<JobResult> {
  const creds = await getGoogleCredentials();
  if (!creds || !hasScope(creds, "youtube")) {
    return {
      status: "skipped",
      message: "YouTube not granted — Settings → Accounts → Google → Add YouTube",
    };
  }
  const token = await refreshAccessToken(creds);

  const ch = await googleGet<Channels>(token, `${YT_DATA_API}/channels`, {
    part: "snippet,statistics,contentDetails",
    mine: "true",
  });
  const c = ch.items?.[0];
  if (!c) throw new Error(`No YouTube channel on ${creds.email ?? "the connected Google account"}`);

  const uploads = await googleGet<PlaylistItems>(token, `${YT_DATA_API}/playlistItems`, {
    part: "contentDetails",
    playlistId: c.contentDetails.relatedPlaylists.uploads,
    maxResults: String(RECENT_VIDEOS),
  });
  const ids = (uploads.items ?? []).map((i) => i.contentDetails.videoId);
  const vids = ids.length
    ? await googleGet<Videos>(token, `${YT_DATA_API}/videos`, { part: "snippet,statistics", id: ids.join(",") })
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
  if (!hasScope(creds, "youtubeAnalytics")) {
    analyticsNote = "watch time off — Reconnect Google to add YouTube Analytics";
  } else {
    try {
      a = await analytics(token);
      await dailySeries(token);
    } catch (err) {
      analyticsNote = `analytics failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
    }
  }

  const s = c.statistics;
  const subscribers = s.hiddenSubscriberCount ? null : num(s.subscriberCount);
  const totalViews = num(s.viewCount);
  const posts: SocialBatch["posts"] = (vids.items ?? []).map((v) => ({
    platform: "youtube",
    postUrl: `https://youtu.be/${v.id}`,
    postedAt: v.snippet.publishedAt ?? null,
    excerpt: v.snippet.title.slice(0, 100),
    impressions: num(v.statistics.viewCount),
    likes: num(v.statistics.likeCount),
    comments: num(v.statistics.commentCount),
  }));
  const ingest = await ingestSocialBatch(
    {
      posts,
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

  const name = c.snippet.customUrl ?? c.snippet.title;
  return {
    status: "ok",
    message:
      `${name} · ${subscribers ?? "hidden"} subscribers · ${totalViews.toLocaleString()} views` +
      (a ? ` · ${Math.round(a.watchMinutes28d / 60).toLocaleString()}h watched (28d)` : "") +
      (analyticsNote ? ` · ${analyticsNote}` : ""),
    summary: { channel: name, subscribers, totalViews, videos: num(s.videoCount), ...recent, ...(a ?? {}), analyticsNote },
  };
}
