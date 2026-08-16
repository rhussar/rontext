"use server";

import { revalidatePath } from "next/cache";
import type { JobKey } from "@/db/schema";
import { isJobKey, JOBS, latestJobRuns, runJob } from "@/lib/jobs/registry";

/**
 * One row per registered job for Settings → Accounts → Automation. Loaded
 * lazily when the panel opens (like import history), not on every page load.
 */
export type AutomationRow = {
  key: JobKey;
  label: string;
  description: string;
  everyHours: number;
  /**
   * Where it executes. Mac and extension rows come from their own heartbeats
   * (launchd agent / Chrome extension) and have no Run now.
   */
  runsOn: "vercel" | "mac" | "extension";
  last: {
    status: "ok" | "failed" | "skipped";
    trigger: "cron" | "manual" | "mac" | "extension";
    startedAt: string;
    /** Wall time in ms. */
    tookMs: number;
    message: string | null;
  } | null;
};

export type AutomationStatus = {
  jobs: AutomationRow[];
  /** Whether Vercel Cron can call the dispatcher at all — presence only. */
  cronEnabled: boolean;
  /** "Daily · 11:00 UTC" — mirrors vercel.json; kept here so the UI can't drift silently. */
  schedule: string;
};

export async function getAutomationStatus(): Promise<AutomationStatus> {
  const latest = await latestJobRuns();
  const lastOf = (key: JobKey): AutomationRow["last"] => {
    const r = latest[key];
    return r
      ? {
          status: r.status,
          trigger: r.trigger,
          startedAt: r.startedAt.toISOString(),
          tookMs: r.finishedAt.getTime() - r.startedAt.getTime(),
          message: r.message,
        }
      : null;
  };
  // The Mac agent isn't in the server registry (it can't run here), but its
  // heartbeat lands in the same ledger, so it gets a row up top with the
  // connectors it belongs with.
  const mac: AutomationRow = {
    key: "messages",
    label: "Messages",
    description: "iMessage/SMS from your Mac — dates and counts only leave it (launchd agent)",
    everyHours: 24,
    runsOn: "mac",
    last: lastOf("messages"),
  };
  const extension: AutomationRow = {
    key: "linkedin",
    label: "LinkedIn visits",
    description: "Chrome extension visits due profiles in a daily batch (cap in Settings → General, default 25); profiles you open yourself are unlimited",
    everyHours: 24,
    runsOn: "extension",
    last: lastOf("linkedin"),
  };
  return {
    jobs: [
      extension,
      mac,
      ...JOBS.map((j) => ({
        key: j.key,
        label: j.label,
        description: j.description,
        everyHours: j.everyHours,
        runsOn: "vercel" as const,
        last: lastOf(j.key),
      })),
    ],
    cronEnabled: !!process.env.CRON_SECRET?.trim(),
    schedule: "Daily · 11:00 UTC",
  };
}

/**
 * Run now. Executes the job inline in this action — the (app) layout's
 * maxDuration is 60s, so the deadline leaves room for the ledger row. The
 * photo job spends real money, but only ever within the monthly budget from
 * Settings, which is the same guard the scheduler runs under.
 */
export async function runJobNow(key: JobKey): Promise<AutomationStatus> {
  if (!isJobKey(key)) throw new Error("Unknown job.");
  await runJob(key, { trigger: "manual", deadline: Date.now() + 45_000 });
  revalidatePath("/", "layout");
  return getAutomationStatus();
}
