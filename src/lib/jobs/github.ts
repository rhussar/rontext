/**
 * Scheduled wrapper over syncGithub() — the same function scripts/sync-github.ts
 * calls. Traffic is a rolling 14-day window per repo, so a missed week loses
 * days for good; running it daily from the cron makes that a non-event.
 */
import { syncGithub } from "@/lib/github-ingest";
import type { JobResult } from "./registry";

export async function githubJob(): Promise<JobResult> {
  const s = await syncGithub({});
  if (!s.ok) {
    // Not configured is a skip, not a failure — nothing is broken, it's just off.
    if (s.error?.includes("GITHUB_TOKEN")) {
      return { status: "skipped", message: "GITHUB_TOKEN not set — add it in Setup" };
    }
    throw new Error(s.error ?? "GitHub sync failed");
  }
  return {
    status: "ok",
    message: `@${s.user} · ${s.followers} followers · ${s.repos} repos · ${s.dayRows} traffic days`,
    summary: {
      user: s.user,
      followers: s.followers,
      totalStars: s.totalStars,
      repos: s.repos,
      trafficRepos: s.trafficRepos,
      dayRows: s.dayRows,
      skipped: s.skipped.length,
    },
  };
}
