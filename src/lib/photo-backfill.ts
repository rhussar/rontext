/**
 * Contact photo backfill from unavatar.io, keyed on each contact's existing
 * linkedin_url. The core loop shared by scripts/backfill-photos.ts (CLI, with
 * its flags and revert) and src/lib/jobs/photos.ts (the scheduled job with a
 * monthly budget). One implementation so the spend cap, the SVG-ghost check
 * and the fill-gaps-only rule can't drift between the two callers.
 *
 * Only public LinkedIn slugs leave the machine — no names, emails or
 * credentials.
 *
 * Why classification is by content type and not status code: unavatar does NOT
 * honour ?fallback=false for this provider. A member with no photo comes back
 * as HTTP 200 carrying a ~451-byte image/svg+xml — LinkedIn's grey ghost
 * silhouette. Trusting the status here would store a placeholder for every such
 * contact. The raster-only allowlist in image-import.ts rejects SVG outright,
 * which is what makes the ghost detectable (and is also what stops a
 * script-carrying SVG being served back from our own origin).
 */
import { and, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactPhotos, contacts } from "@/db/schema";
import { normalizeLinkedin } from "@/lib/contact-merge";
import { imageFromResponse } from "@/lib/image-import";
import { PHOTO_LIMIT_LABEL, PHOTO_MAX_BYTES, storeContactPhoto } from "@/lib/photos";

/** $0.010 per token, per unavatar's PRO pricing. */
export const PRICE_PER_TOKEN = 0.01;
/**
 * Absolute ceiling on a single run's spend, in dollars. Not overridable — the
 * point of a spend cap is that a typo in a flag can't raise it.
 */
export const HARD_CAP_USD = 15;
/**
 * Budget is reserved pessimistically per in-flight request: an origin-tier
 * lookup costs 1 token, but a residential-tier one costs 5, and we don't know
 * which we'll get until the response lands. Reserving the worst case is what
 * makes the cap a guarantee rather than an estimate.
 */
const WORST_CASE_TOKENS = 5;
/**
 * Anything this small isn't a photograph. Belt-and-braces behind the SVG check
 * in case unavatar ever switches its placeholder to a tiny raster.
 */
const MIN_PHOTO_BYTES = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 10;

export type PhotoTarget = { slug: string; contactIds: number[]; name: string };
type Verdict = "hit" | "miss" | "error" | "fatal";

export type BackfillOptions = {
  apiKey: string;
  /** Stop once spend reaches this many dollars. Capped at HARD_CAP_USD. */
  maxCost: number;
  /** Only these contact ids. */
  ids?: number[] | null;
  /** Re-look-up contacts previously confirmed to have no photo. */
  recheck?: boolean;
  /** Overwrite existing photos. Callers must pair with `ids`. */
  force?: boolean;
  /** Only the first N distinct slugs (ordered by contact id, so runs walk forward). */
  limit?: number | null;
  concurrency?: number;
  /** Epoch ms; the pool stops picking up new targets past this. */
  deadline?: number;
  log?: (line: string) => void;
};

export type BackfillSummary = {
  candidates: number;
  noSlug: number;
  distinctSlugs: number;
  attempted: number;
  hits: number;
  misses: number;
  errors: number;
  spentTokens: number;
  spentUsd: number;
  tiers: Record<string, number>;
  /** Why the run ended early, if it did. */
  stopped: string | null;
  /** Targets in scope this run that weren't attempted (cap, breaker, deadline). */
  remaining: number;
};

/** linkedin.com/in/<slug> → slug. Legacy /pub/ URLs have none; those are skipped. */
export function slugFrom(url: string | null): string | null {
  const normalized = normalizeLinkedin(url ?? undefined);
  if (!normalized) return null;
  const match = normalized.match(/\/in\/([^/?#]+)/);
  if (!match) return null;
  try {
    // Some slugs carry percent-encoded non-ASCII; round-trip so we send exactly
    // one level of encoding rather than double-encoding an already-escaped one.
    return encodeURIComponent(decodeURIComponent(match[1]));
  } catch {
    return encodeURIComponent(match[1]);
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The contacts a run would look up, grouped one target per slug. Exposed so
 * the CLI's --dry-run and the job's "nothing to do" short-circuit share it.
 *
 * The contact ids travel *inside* each target — never rely on array position
 * to match a result back to a row, or the wrong face lands on the wrong name.
 */
export async function photoTargets(
  opts: Pick<BackfillOptions, "ids" | "recheck" | "force">,
): Promise<{ targets: PhotoTarget[]; candidates: number; noSlug: number }> {
  const db = getDb();
  const filters = [isNull(contacts.archivedAt), isNotNull(contacts.linkedinUrl)];
  if (opts.ids?.length) filters.push(inArray(contacts.id, opts.ids));
  if (!opts.recheck && !opts.force) filters.push(isNull(contacts.photoCheckedAt));
  if (!opts.force) {
    filters.push(
      sql`not exists (select 1 from ${contactPhotos} where ${contactPhotos.contactId} = ${contacts.id})`,
    );
  }
  const rows = await db
    .select({ id: contacts.id, name: contacts.fullName, url: contacts.linkedinUrl })
    .from(contacts)
    .where(and(...filters))
    .orderBy(contacts.id);

  const bySlug = new Map<string, PhotoTarget>();
  let noSlug = 0;
  for (const row of rows) {
    const slug = slugFrom(row.url);
    if (!slug) {
      noSlug++;
      continue;
    }
    const existing = bySlug.get(slug);
    if (existing) existing.contactIds.push(row.id);
    else bySlug.set(slug, { slug, contactIds: [row.id], name: row.name });
  }
  return { targets: [...bySlug.values()], candidates: rows.length, noSlug };
}

export async function backfillPhotos(opts: BackfillOptions): Promise<BackfillSummary> {
  if (!Number.isFinite(opts.maxCost) || opts.maxCost <= 0) {
    throw new Error(`maxCost must be a positive number, got ${opts.maxCost}`);
  }
  if (opts.maxCost > HARD_CAP_USD) {
    throw new Error(
      `maxCost ${opts.maxCost} exceeds the hard cap of $${HARD_CAP_USD}. ` +
        `Raise HARD_CAP_USD in photo-backfill.ts if that is genuinely intended.`,
    );
  }
  if (opts.force && !opts.ids?.length) {
    throw new Error("force requires ids; refusing to overwrite photos in bulk.");
  }
  if (!opts.apiKey) throw new Error("UNAVATAR_API_KEY is not set.");

  const log = opts.log ?? (() => {});
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 4));
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const db = getDb();

  const { targets: all, candidates, noSlug } = await photoTargets(opts);
  const targets = opts.limit ? all.slice(0, opts.limit) : all;

  let next = 0;
  let spentTokens = 0;
  let inFlight = 0;
  let hits = 0;
  let misses = 0;
  let errors = 0;
  let done = 0;
  let consecutiveFailures = 0;
  let stopped: string | null = null;
  let pausedUntil = 0;
  const tiers = new Map<string, number>();

  const budgetLeft = () =>
    opts.maxCost - (spentTokens + inFlight * WORST_CASE_TOKENS) * PRICE_PER_TOKEN;

  async function gate() {
    while (Date.now() < pausedUntil) await sleep(Math.min(1_000, pausedUntil - Date.now()));
  }

  async function lookup(target: PhotoTarget): Promise<Verdict> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await gate();
      let res: Response;
      try {
        res = await fetch(`https://unavatar.io/linkedin/${target.slug}`, {
          headers: { "x-api-key": opts.apiKey },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (attempt === MAX_ATTEMPTS) return "error";
        await sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)) + Math.random() * 250);
        continue;
      }

      spentTokens += Number(res.headers.get("x-unavatar-cost") ?? 0);
      const tier = res.headers.get("x-proxy-tier") ?? "unknown";
      tiers.set(tier, (tiers.get(tier) ?? 0) + 1);

      // A bad or exhausted key fails identically for every remaining target;
      // stopping now is the difference between one wasted call and 1,300.
      if (res.status === 401 || res.status === 403) {
        stopped = `unavatar rejected the API key (HTTP ${res.status})`;
        return "fatal";
      }

      if (res.status === 429 || res.status >= 500) {
        // Pause the whole pool, not just this worker — the limit is per account.
        const wait =
          parseRetryAfter(res.headers.get("retry-after")) ??
          Math.min(30_000, 1_000 * 2 ** (attempt - 1));
        pausedUntil = Math.max(pausedUntil, Date.now() + wait + Math.random() * 250);
        if (attempt === MAX_ATTEMPTS) return "error";
        continue;
      }

      if (res.status === 404 || res.status === 410) return "miss";

      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      // The grey-ghost placeholder, served as 200. Not an error, just no photo.
      if (contentType === "image/svg+xml") return "miss";

      const intake = await imageFromResponse(res, PHOTO_MAX_BYTES, PHOTO_LIMIT_LABEL);
      if (!intake.ok) {
        log(`  miss ${target.name.padEnd(30)} ${target.slug} — ${intake.error}`);
        return "miss";
      }
      if (Math.floor((intake.data.length * 3) / 4) < MIN_PHOTO_BYTES) {
        log(`  miss ${target.name.padEnd(30)} ${target.slug} — under size floor`);
        return "miss";
      }

      for (const contactId of target.contactIds) {
        const stored = await storeContactPhoto(contactId, intake, "unavatar", {
          fillGapsOnly: !opts.force,
        });
        if (!stored.ok) {
          log(`  warn #${contactId} ${target.slug}: ${stored.error}`);
        }
      }
      return "hit";
    }
    return "error";
  }

  async function worker() {
    while (true) {
      if (stopped) return;
      if (budgetLeft() <= 0) {
        stopped ??= `spend cap of $${opts.maxCost.toFixed(2)} reached`;
        return;
      }
      if (Date.now() >= deadline) {
        stopped ??= "time budget reached";
        return;
      }
      const target = targets[next++];
      if (!target) return;

      inFlight++;
      let verdict: Verdict;
      try {
        verdict = await lookup(target);
      } finally {
        inFlight--;
      }

      if (verdict === "fatal") return;

      if (verdict === "error") {
        errors++;
        consecutiveFailures++;
        // photo_checked_at stays null so a transient failure retries next run.
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stopped ??= `${MAX_CONSECUTIVE_FAILURES} consecutive failures — circuit breaker`;
          return;
        }
      } else {
        consecutiveFailures = 0;
        if (verdict === "hit") hits++;
        else misses++;
        // Stamped for a hit AND a confirmed miss, so re-runs don't re-pay.
        await db
          .update(contacts)
          .set({ photoCheckedAt: new Date() })
          .where(inArray(contacts.id, target.contactIds));
      }

      done++;
      if (done % 25 === 0 || done === targets.length) {
        log(
          `  ${String(done).padStart(4)}/${targets.length} · ` +
            `hits ${hits} · misses ${misses} · errors ${errors} · ` +
            `${spentTokens} tokens · $${(spentTokens * PRICE_PER_TOKEN).toFixed(2)}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  return {
    candidates,
    noSlug,
    distinctSlugs: all.length,
    attempted: done,
    hits,
    misses,
    errors,
    spentTokens,
    spentUsd: Number((spentTokens * PRICE_PER_TOKEN).toFixed(2)),
    tiers: Object.fromEntries(tiers),
    stopped,
    remaining: targets.length - done,
  };
}
