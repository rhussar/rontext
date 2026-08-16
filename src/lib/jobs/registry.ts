/**
 * The scheduled-job registry — what /api/cron/daily runs and what Settings →
 * Accounts → Automation displays.
 *
 * Every job is a plain async function over the same libs the CLI scripts use;
 * this module adds the three things a scheduler needs on top: an interval
 * ("is it due?"), a deadline (serverless functions are time-boxed, so jobs get
 * a wall-clock budget and must stop cleanly rather than be killed), and a
 * ledger row in job_runs whatever happens — including a thrown error, which is
 * what turns a dead token into a red row on the Accounts card instead of
 * silence.
 *
 * Pure module, not "use server": the cron route and the "Run now" server
 * action both call it, and it must never be reachable from the client.
 *
 * Only an `ok` run satisfies the interval. A `failed` or `skipped` (not
 * configured) job is re-attempted on the next dispatch, which is at most daily,
 * so a key added in Setup takes effect within a day without anyone
 * remembering to press Run now — and the ledger keeps saying "skipped" until
 * then, which is the honest state.
 */

import { desc, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { jobRuns, JOB_KEYS, type JobKey } from "@/db/schema";
import { gmailJob } from "./gmail";
import { googleContactsJob } from "./google-contacts";
import { googleCalendarJob } from "./google-calendar";
import { githubJob } from "./github";
import { xMetricsJob } from "./x-metrics";
import { photosJob } from "./photos";
import { backupJob } from "./backup";

export type JobTrigger = "cron" | "manual";

export type JobContext = {
  /** Epoch ms. Jobs must return before this; long ones check it in their loop. */
  deadline: number;
  trigger: JobTrigger;
  log: (line: string) => void;
};

export type JobResult = {
  status: "ok" | "skipped";
  /** One human line for the Automation row. */
  message: string;
  summary?: Record<string, unknown>;
};

/**
 * A failure that still has something worth recording — most importantly money
 * already spent. A plain `throw` lands a row with `summary = null`, which for
 * the photo job means the dollars it burned before dying are invisible to
 * monthlySummarySum() and the monthly ceiling over-counts its headroom.
 */
export class JobFailure extends Error {
  readonly summary: Record<string, unknown>;
  constructor(message: string, summary: Record<string, unknown>) {
    super(message);
    this.name = "JobFailure";
    this.summary = summary;
  }
}

export type JobDef = {
  key: JobKey;
  label: string;
  /** One line, sentence case, no trailing period — shown under the label. */
  description: string;
  /** Minimum hours between successful runs. */
  everyHours: number;
  run: (ctx: JobContext) => Promise<JobResult>;
};

/**
 * Order matters: the Google connectors first (they're what the CRM is about,
 * and Gmail is the one that can take a while), cheap API pulls next, the
 * time-consuming photo walk last so it inherits whatever wall-clock is left
 * rather than starving the others.
 */
export const JOBS: JobDef[] = [
  {
    key: "gmail",
    label: "Gmail",
    description: "Who you email — dates and counts only, never message text",
    everyHours: 20,
    run: gmailJob,
  },
  {
    key: "google-calendar",
    label: "Google Calendar",
    description: "Meetings as interactions — attendees and dates only",
    everyHours: 20,
    run: googleCalendarJob,
  },
  {
    key: "google-contacts",
    label: "Google Contacts",
    description: "Fills missing birthdays, emails and phones on people you already have",
    everyHours: 6 * 24,
    run: googleContactsJob,
  },
  {
    key: "github",
    label: "GitHub stats",
    description: "Followers, stars and 14-day repo traffic",
    everyHours: 20,
    run: githubJob,
  },
  {
    key: "x-metrics",
    label: "X metrics",
    description: "Own-account followers and recent post metrics via the X API",
    everyHours: 6 * 24,
    run: xMetricsJob,
  },
  {
    key: "backup",
    label: "Backup",
    description: "Nightly JSON snapshot of contacts, notes, reminders and drafts",
    everyHours: 20,
    run: backupJob,
  },
  {
    key: "photos",
    label: "Contact photos",
    description: "Fills missing avatars from LinkedIn slugs, within the monthly budget",
    everyHours: 20,
    run: photosJob,
  },
];

const JOB_BY_KEY = new Map(JOBS.map((j) => [j.key, j]));

export function isJobKey(v: string): v is JobKey {
  return (JOB_KEYS as readonly string[]).includes(v);
}

export type JobRunRow = typeof jobRuns.$inferSelect;

/** Latest run per job, whatever its status — for the Automation panel. */
export async function latestJobRuns(): Promise<Partial<Record<JobKey, JobRunRow>>> {
  // Highest id per job == latest run per job (ids are serial, rows are
  // inserted at finish time).
  const rows = await getDb()
    .select()
    .from(jobRuns)
    .where(sql`${jobRuns.id} in (select max(id) from job_runs group by job)`);
  const out: Partial<Record<JobKey, JobRunRow>> = {};
  for (const r of rows) out[r.job] = r;
  return out;
}

async function lastOkAt(key: JobKey): Promise<Date | null> {
  const [row] = await getDb()
    .select({ startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .where(sql`${jobRuns.job} = ${key} and ${jobRuns.status} = 'ok'`)
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

/**
 * Run one job to completion and record it. Never throws: an exception becomes
 * a `failed` row with the error's message, because a job blowing up must not
 * take the rest of the dispatch — or the ledger — down with it.
 */
export async function runJob(
  key: JobKey,
  opts: { trigger: JobTrigger; deadline: number; log?: (line: string) => void },
): Promise<JobRunRow> {
  const def = JOB_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown job "${key}"`);
  const startedAt = new Date();
  const log = opts.log ?? (() => {});
  let status: JobRunRow["status"];
  let message: string | null;
  let summary: Record<string, unknown> | null = null;
  try {
    const result = await def.run({ deadline: opts.deadline, trigger: opts.trigger, log });
    status = result.status;
    message = result.message;
    summary = result.summary ?? null;
  } catch (err) {
    status = "failed";
    // Keep this generic-safe: messages from fetch/DB may embed URLs but never
    // the secret itself (all our clients send tokens in headers).
    message = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
    // A JobFailure carries what the run got done before it died, so spend
    // stays on the ledger even on the failure path.
    if (err instanceof JobFailure) summary = err.summary;
  }
  const [row] = await getDb()
    .insert(jobRuns)
    .values({
      job: key,
      status,
      trigger: opts.trigger,
      startedAt,
      finishedAt: new Date(),
      message,
      summary,
    })
    .returning();
  log(`${key}: ${status} — ${message ?? ""}`);
  return row;
}

export type DispatchReport = {
  ran: JobRunRow[];
  /** Jobs whose interval hasn't elapsed since their last ok run. */
  notDue: JobKey[];
  /** Jobs skipped because the deadline was already reached. */
  outOfTime: JobKey[];
};

/**
 * The daily dispatch: every job that's due, in registry order, sharing one
 * deadline. `force` ignores the interval (Run now); `only` limits to one job.
 */
export async function runDueJobs(opts: {
  trigger: JobTrigger;
  deadline: number;
  only?: JobKey;
  force?: boolean;
  log?: (line: string) => void;
}): Promise<DispatchReport> {
  const report: DispatchReport = { ran: [], notDue: [], outOfTime: [] };
  const defs = opts.only ? JOBS.filter((j) => j.key === opts.only) : JOBS;
  for (const def of defs) {
    if (!opts.force) {
      const last = await lastOkAt(def.key);
      if (last && Date.now() - last.getTime() < def.everyHours * 3_600_000) {
        report.notDue.push(def.key);
        continue;
      }
    }
    // Leave at least 5s so the run row can still be written.
    if (Date.now() > opts.deadline - 5_000) {
      report.outOfTime.push(def.key);
      continue;
    }
    report.ran.push(
      await runJob(def.key, { trigger: opts.trigger, deadline: opts.deadline, log: opts.log }),
    );
  }
  return report;
}

/** Sum of a numeric summary field across this calendar month's runs — the photo budget ledger. */
export async function monthlySummarySum(key: JobKey, field: string): Promise<number> {
  const [row] = await getDb()
    .select({
      total: sql<number>`coalesce(sum((${jobRuns.summary}->>${field})::numeric), 0)::float`,
    })
    .from(jobRuns)
    .where(
      sql`${jobRuns.job} = ${key} and ${jobRuns.startedAt} >= date_trunc('month', now())`,
    );
  return Number(row?.total ?? 0);
}
