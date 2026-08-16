/**
 * Daily Gmail sync — the scheduled successor to "ask Claude Code to sync
 * Gmail". Same reader (gmail-sync.ts), same metadata-only request shape, same
 * candidates queue; the only new decision is the window:
 *
 *  - first ever run (no gmail row in sync_runs): a 12-month baseline, capped so
 *    it fits the function's time box. If the cap bites, buckets are suppressed
 *    for that run and the daily windows below fill them in going forward.
 *  - every run after: from the first of the *previous* month, so both months
 *    in the window are scanned completely and greatest() stays honest. Cheap:
 *    a couple of hundred metadata reads for a normal inbox.
 *
 * Skipped (not failed) when Google isn't connected. A dead refresh token is a
 * failure — that's the red row that tells you to reconnect.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { syncRuns } from "@/db/schema";
import { getGoogleCredentials, hasScope, refreshAccessToken, fetchGmailAddress } from "@/lib/google-auth";
import { monthStart, syncGmail } from "@/lib/gmail-sync";
import type { JobContext, JobResult } from "./registry";

const BASELINE_MONTHS = 12;
const BASELINE_MAX = 2000;
const DAILY_MAX = 3000;
/** Room after the reader stops for the ingest writes + the ledger row. */
const DEADLINE_MARGIN_MS = 30_000;

export async function gmailJob(ctx: JobContext): Promise<JobResult> {
  const creds = await getGoogleCredentials();
  if (!creds) {
    return { status: "skipped", message: "Google not connected — Settings → Accounts → Connect Google" };
  }
  if (!hasScope(creds, "gmail")) {
    return { status: "skipped", message: "The Google grant doesn't include Gmail — reconnect to add it" };
  }
  const accessToken = await refreshAccessToken(creds);
  const me = creds.email ?? (await fetchGmailAddress(accessToken));
  if (!me) throw new Error("Couldn't determine the mailbox address");

  const [prior] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(syncRuns)
    .where(sql`${syncRuns.connector} = 'gmail'`);
  const baseline = (prior?.n ?? 0) === 0;

  const s = await syncGmail({
    accessToken,
    me,
    window: baseline ? { months: BASELINE_MONTHS } : { sinceMonth: monthStart(1) },
    max: baseline ? BASELINE_MAX : DAILY_MAX,
    deadline: ctx.deadline - DEADLINE_MARGIN_MS,
    log: ctx.log,
  });
  if (!s.ok) throw new Error(s.error ?? "Gmail sync failed");

  const note = s.truncated
    ? ` · truncated (${s.deadlineHit ? "time budget" : "cap"}), monthly buckets skipped this run`
    : "";
  return {
    status: "ok",
    message:
      `${s.windowLabel} · ${s.sentRead + s.inboxRead} messages read · ${s.matched} people matched` +
      (s.enriched ? ` · ${s.enriched} enriched` : "") +
      (s.candidatesNew ? ` · ${s.candidatesNew} new to review` : "") +
      note,
    summary: {
      me,
      baseline,
      window: s.windowLabel,
      sentRead: s.sentRead,
      inboxRead: s.inboxRead,
      addressesSeen: s.addressesSeen,
      kept: s.kept,
      matched: s.matched,
      enriched: s.enriched,
      candidatesNew: s.candidatesNew,
      candidatesPending: s.candidatesPending,
      periods: s.periods,
      truncated: s.truncated,
      deadlineHit: s.deadlineHit,
    },
  };
}
