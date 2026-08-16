/**
 * Scheduled photo backfill: the same loop as scripts/backfill-photos.ts, run
 * daily under a *monthly* dollar budget set in Settings → General.
 *
 * Budget accounting is a sum over this month's job_runs summaries (each run
 * records `spentUsd`), so a run that stops early — deadline, breaker, cap —
 * still counts what it spent, and tomorrow's run picks up where it left off
 * (targets are whatever still lacks a photo_checked_at stamp). Two ceilings
 * apply on every run, and both are enforced inside backfillPhotos(): what's
 * left of the month's budget, and the CLI's non-overridable per-run hard cap.
 *
 * Off by default (budget 0): a fresh install must never spend money on a
 * schedule nobody chose.
 */
import { getSettings } from "@/lib/actions/settings";
import { getSecret } from "@/lib/secrets";
import { backfillPhotos, HARD_CAP_USD, photoTargets } from "@/lib/photo-backfill";
import { JobFailure, monthlySummarySum, type JobContext, type JobResult } from "./registry";

/** Anything under a cent can't buy a lookup. */
const MIN_USEFUL_USD = 0.01;
/** Time left for the run row + response after the loop stops. */
const DEADLINE_MARGIN_MS = 10_000;

export async function photosJob(ctx: JobContext): Promise<JobResult> {
  const settings = await getSettings();
  const budget = settings.photoMonthlyBudgetUsd;
  if (budget <= 0) {
    return {
      status: "skipped",
      message: "Off — set a monthly photo budget in Settings → General to enable",
    };
  }
  const apiKey = await getSecret("UNAVATAR_API_KEY");
  if (!apiKey) {
    return { status: "skipped", message: "UNAVATAR_API_KEY not set — add it in Setup" };
  }

  const spent = await monthlySummarySum("photos", "spentUsd");
  const left = budget - spent;
  if (left < MIN_USEFUL_USD) {
    return {
      status: "skipped",
      message: `Monthly budget used ($${spent.toFixed(2)} of $${budget.toFixed(2)}) — resumes next month`,
      summary: { spentUsd: 0, budget, spentThisMonth: spent },
    };
  }

  const { targets } = await photoTargets({});
  if (!targets.length) {
    return {
      status: "ok",
      message: "Nothing to do — every contact with a LinkedIn slug has been checked",
      summary: { spentUsd: 0, budget, spentThisMonth: spent },
    };
  }

  const s = await backfillPhotos({
    apiKey,
    maxCost: Math.min(left, HARD_CAP_USD),
    concurrency: 4,
    deadline: ctx.deadline - DEADLINE_MARGIN_MS,
    log: ctx.log,
  });

  // A rejected key is a real failure worth a red row, not a quiet stop. It
  // throws a JobFailure rather than an Error so whatever it spent before the
  // key was rejected still lands on the ledger — a bare throw writes
  // `summary = null`, and monthlySummarySum() would hand next month's run
  // that money back.
  if (s.stopped?.includes("rejected the API key")) {
    throw new JobFailure(s.stopped, {
      spentUsd: s.spentUsd,
      spentTokens: s.spentTokens,
      budget,
      spentThisMonth: spent + s.spentUsd,
      hits: s.hits,
      misses: s.misses,
      errors: s.errors,
      attempted: s.attempted,
      stopped: s.stopped,
    });
  }

  const remainingNote = s.remaining
    ? ` · ${s.remaining} left for next run${s.stopped ? ` (${s.stopped})` : ""}`
    : "";
  return {
    status: "ok",
    message:
      `${s.hits} added · ${s.misses} without a photo · $${s.spentUsd.toFixed(2)} spent` +
      ` ($${(spent + s.spentUsd).toFixed(2)} of $${budget.toFixed(2)} this month)` +
      remainingNote,
    summary: {
      spentUsd: s.spentUsd,
      spentTokens: s.spentTokens,
      budget,
      spentThisMonth: spent + s.spentUsd,
      hits: s.hits,
      misses: s.misses,
      errors: s.errors,
      attempted: s.attempted,
      remaining: s.remaining,
      stopped: s.stopped,
      tiers: s.tiers,
    },
  };
}
