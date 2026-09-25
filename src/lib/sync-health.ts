/**
 * Is each sync actually landing? One answer, used in two places:
 *
 * - `get_person_context` refuses when a *required* sync is stale (Messages,
 *   Google Calendar — the owner's choice), because stale context makes for
 *   bad drafts.
 * - Home shows a banner when any *tracked* sync is stale, so a broken sync
 *   comes to the owner instead of waiting to be found in Settings. Before
 *   this, the Mac agents sat silent for 19 days (Sep 5–23, 2026) and Calendar
 *   was skipped daily for a month, both visible only inside Settings.
 *
 * Judged on the last *successful* run, not the last run: a "skipped" row
 * every day (Calendar without its scope) or no row at all (a Mac that's off)
 * are exactly the failures a latest-status check misses.
 */
import { desc, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { jobRuns, type JobKey } from "@/db/schema";

/** The Mac agent and the daily cron both run about once a day; allow a missed night. */
export const SYNC_MAX_AGE_HOURS = 48;

export type SyncDef = {
  job: JobKey;
  label: string;
  /** What to do about it — one clause, shown after the problem. */
  fix: string;
};

const MESSAGES: SyncDef = {
  job: "messages",
  label: "Messages",
  fix: "it runs on the Mac via the launchd agent; check the Mac is on and node has Full Disk Access, or run web/scripts/install-mac-agent.sh --status",
};
const WHATSAPP: SyncDef = {
  job: "whatsapp",
  label: "WhatsApp",
  fix: "it runs on the Mac; check WhatsApp for Mac is installed and linked, and the launchd agent is loaded (web/scripts/install-mac-agent.sh --status)",
};
const GMAIL: SyncDef = {
  job: "gmail",
  label: "Gmail",
  fix: "reconnect Google in Settings → Connections → Google, then Sync",
};
const CALENDAR: SyncDef = {
  job: "google-calendar",
  label: "Google Calendar",
  fix: "reconnect Google with Calendar access in Settings → Connections → Google, then Sync",
};

/** What get_person_context insists on. */
export const REQUIRED_SYNCS: SyncDef[] = [MESSAGES, CALENDAR];
/** What Home watches. */
export const TRACKED_SYNCS: SyncDef[] = [MESSAGES, WHATSAPP, GMAIL, CALENDAR];

export type SyncState = {
  job: JobKey;
  label: string;
  lastOkAt: string | null;
  ageHours: number | null;
  ok: boolean;
  /** Short, for a banner: "hasn't synced in 3 days" / "has never synced". */
  headline?: string;
  /** The latest run's own message when it wasn't ok — usually the real cause. */
  latestError?: string;
  /** Full sentence for agents: label, headline, latest error and the fix. */
  problem?: string;
  fix: string;
};

export async function checkSyncs(defs: SyncDef[]): Promise<{ ok: boolean; syncs: SyncState[] }> {
  const rows = await getDb()
    .select({
      job: jobRuns.job,
      status: jobRuns.status,
      message: jobRuns.message,
      startedAt: jobRuns.startedAt,
    })
    .from(jobRuns)
    .where(inArray(jobRuns.job, defs.map((d) => d.job)))
    .orderBy(desc(jobRuns.startedAt))
    .limit(400);

  const syncs = defs.map(({ job, label, fix }): SyncState => {
    const mine = rows.filter((r) => r.job === job);
    const lastOk = mine.find((r) => r.status === "ok");
    const latest = mine[0];
    const ageHours = lastOk ? (Date.now() - lastOk.startedAt.getTime()) / 3_600_000 : null;
    const ok = ageHours !== null && ageHours <= SYNC_MAX_AGE_HOURS;
    if (ok) {
      return { job, label, lastOkAt: lastOk!.startedAt.toISOString(), ageHours: Math.round(ageHours!), ok, fix };
    }
    const headline = !lastOk
      ? "has never synced successfully"
      : ageHours! < 72
        ? `hasn't synced in ${Math.round(ageHours!)} hours`
        : `hasn't synced in ${Math.floor(ageHours! / 24)} days`;
    const latestError = latest && latest.status !== "ok" && latest.message ? latest.message : undefined;
    return {
      job,
      label,
      lastOkAt: lastOk?.startedAt.toISOString() ?? null,
      ageHours: ageHours === null ? null : Math.round(ageHours),
      ok,
      headline,
      ...(latestError ? { latestError } : {}),
      problem: `${label} ${headline}${latestError ? ` (latest run: ${latestError})` : ""} — ${fix}`,
      fix,
    };
  });
  return { ok: syncs.every((s) => s.ok), syncs };
}
