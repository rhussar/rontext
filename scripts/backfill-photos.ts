/**
 * Backfill contact photos from unavatar.io, keyed on each contact's existing
 * linkedin_url:
 *
 *   set -a && source .env.local && set +a && npx tsx scripts/backfill-photos.ts [flags]
 *
 * Flags:
 *   --dry-run        List targets and resolved slugs, make zero requests.
 *   --limit N        Only process the first N targets (ordered by contact id,
 *                    so repeated runs walk forward through the list).
 *   --concurrency N  Parallel lookups (default 4).
 *   --max-cost N     Stop once spend reaches $N. Default and ceiling are both
 *                    $15 — a larger value is refused, not clamped silently.
 *   --recheck        Re-look-up contacts previously confirmed to have no photo.
 *   --ids 1,2,3      Only these contact ids.
 *   --force          Overwrite existing photos. Requires --ids, so a stray run
 *                    can never clobber photos that were added by hand.
 *   --revert         Delete every source="unavatar" photo and clear its
 *                    photo_checked_at stamp. Honours --dry-run.
 *
 * Runs locally, not on Vercel: it's a one-off backfill and the API key has no
 * business sitting in a serverless function's env. Only public LinkedIn slugs
 * leave the machine — no names, emails, or credentials.
 *
 * Why classification is by content type and not status code: unavatar does NOT
 * honour ?fallback=false for this provider. A member with no photo comes back
 * as HTTP 200 carrying a ~451-byte image/svg+xml — LinkedIn's grey ghost
 * silhouette. Trusting the status here would store a placeholder for every such
 * contact. The raster-only allowlist in image-import.ts rejects SVG outright,
 * which is what makes the ghost detectable (and is also what stops a
 * script-carrying SVG being served back from our own origin).
 */
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactPhotos, contacts } from "../src/db/schema";
import { normalizeLinkedin } from "../src/lib/contact-merge";
import { imageFromResponse } from "../src/lib/image-import";
import { getSecret } from "../src/lib/secrets";
import { PHOTO_LIMIT_LABEL, PHOTO_MAX_BYTES, storeContactPhoto } from "../src/lib/photos";

/** $0.010 per token, per unavatar's PRO pricing. */
const PRICE_PER_TOKEN = 0.01;
/**
 * Absolute ceiling on this script's spend, in dollars. Not overridable — the
 * point of a spend cap is that a typo in a flag can't raise it.
 */
const HARD_CAP_USD = 15;
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

type Target = { slug: string; contactIds: number[]; name: string };
type Verdict = "hit" | "miss" | "error" | "fatal";

function parseArgs() {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };

  const maxCostRaw = valueOf("--max-cost");
  const maxCost = maxCostRaw === null ? HARD_CAP_USD : Number(maxCostRaw);
  if (!Number.isFinite(maxCost) || maxCost <= 0) {
    throw new Error(`--max-cost must be a positive number, got "${maxCostRaw}"`);
  }
  if (maxCost > HARD_CAP_USD) {
    throw new Error(
      `--max-cost ${maxCost} exceeds the hard cap of $${HARD_CAP_USD}. ` +
        `Raise HARD_CAP_USD in this file if that is genuinely intended.`,
    );
  }

  const limitRaw = valueOf("--limit");
  const concurrencyRaw = valueOf("--concurrency");
  const idsRaw = valueOf("--ids");

  const force = args.includes("--force");
  const ids = idsRaw
    ? idsRaw.split(",").map((s) => Number(s.trim())).filter(Number.isInteger)
    : null;
  if (force && (!ids || !ids.length)) {
    throw new Error("--force requires --ids; refusing to overwrite photos in bulk.");
  }

  return {
    dryRun: args.includes("--dry-run"),
    recheck: args.includes("--recheck"),
    revert: args.includes("--revert"),
    force,
    ids,
    limit: limitRaw ? Number(limitRaw) : null,
    concurrency: Math.max(1, Math.min(8, concurrencyRaw ? Number(concurrencyRaw) : 4)),
    maxCost,
  };
}

/** linkedin.com/in/<slug> → slug. Legacy /pub/ URLs have none; those are skipped. */
function slugFrom(url: string | null): string | null {
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

async function revert(dryRun: boolean) {
  const db = getDb();
  const rows = await db
    .select({ contactId: contactPhotos.contactId })
    .from(contactPhotos)
    .where(eq(contactPhotos.source, "unavatar"));
  const ids = rows.map((r) => r.contactId);

  const [{ others }] = await db
    .select({ others: sql<number>`count(*)::int` })
    .from(contactPhotos)
    .where(notInArray(contactPhotos.source, ["unavatar"]));

  console.log(`${dryRun ? "[dry-run] " : ""}Backfilled photos to delete: ${ids.length}`);
  console.log(`  photos from other sources, left untouched: ${others}`);
  if (dryRun || !ids.length) return;

  await db.delete(contactPhotos).where(eq(contactPhotos.source, "unavatar"));
  await db
    .update(contacts)
    .set({ photoCheckedAt: null })
    .where(inArray(contacts.id, ids));
  console.log("Reverted.");
}

async function main() {
  const opts = parseArgs();

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Run with:\n" +
        "  set -a && source .env.local && set +a && npx tsx scripts/backfill-photos.ts",
    );
  }

  if (opts.revert) return revert(opts.dryRun);

  // Settings → Setup value (DB) or .env.local — either works; this script
  // already reaches the same database as the app.
  const apiKey = (await getSecret("UNAVATAR_API_KEY")) ?? "";
  if (!apiKey && !opts.dryRun) {
    throw new Error(
      "UNAVATAR_API_KEY is not set. Add it in Settings → Setup (or web/.env.local), then run:\n" +
        "  set -a && source .env.local && set +a && npx tsx scripts/backfill-photos.ts",
    );
  }

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

  // One request per slug, applied to every contact holding it. URL variants
  // mean the same person can appear on two rows even with the unique index.
  // The contact ids travel *inside* each target — never rely on array position
  // to match a result back to a row, or the wrong face lands on the wrong name.
  const bySlug = new Map<string, Target>();
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

  let targets = [...bySlug.values()];
  const totalTargets = targets.length;
  if (opts.limit) targets = targets.slice(0, opts.limit);

  console.log(`candidates:            ${rows.length}`);
  console.log(`  no /in/ slug:        ${noSlug}`);
  console.log(`  distinct slugs:      ${totalTargets}`);
  console.log(`  processing:          ${targets.length}`);
  console.log(`spend cap:             $${opts.maxCost.toFixed(2)} (hard ceiling $${HARD_CAP_USD})`);
  console.log(
    `projected at 1 token each: $${(targets.length * PRICE_PER_TOKEN).toFixed(2)}\n`,
  );

  if (opts.dryRun) {
    for (const t of targets) {
      console.log(`  ${String(t.contactIds.join(",")).padEnd(10)} ${t.name.padEnd(32)} ${t.slug}`);
    }
    console.log(`\n[dry-run] ${targets.length} lookups would be made. No requests sent.`);
    return;
  }

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

  async function lookup(target: Target): Promise<Verdict> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await gate();
      let res: Response;
      try {
        res = await fetch(`https://unavatar.io/linkedin/${target.slug}`, {
          headers: { "x-api-key": apiKey },
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
        console.log(`  miss ${target.name.padEnd(30)} ${target.slug} — ${intake.error}`);
        return "miss";
      }
      if (Math.floor((intake.data.length * 3) / 4) < MIN_PHOTO_BYTES) {
        console.log(`  miss ${target.name.padEnd(30)} ${target.slug} — under size floor`);
        return "miss";
      }

      for (const contactId of target.contactIds) {
        const stored = await storeContactPhoto(contactId, intake, "unavatar", {
          fillGapsOnly: !opts.force,
        });
        if (!stored.ok) {
          console.log(`  warn #${contactId} ${target.slug}: ${stored.error}`);
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
        console.log(
          `  ${String(done).padStart(4)}/${targets.length} · ` +
            `hits ${hits} · misses ${misses} · errors ${errors} · ` +
            `${spentTokens} tokens · $${(spentTokens * PRICE_PER_TOKEN).toFixed(2)}`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, targets.length) }, worker),
  );

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(contactPhotos);
  const remaining = targets.length - done;

  console.log(`\nhits ${hits} · misses ${misses} · errors ${errors}`);
  console.log(`proxy tiers: ${[...tiers].map(([t, c]) => `${t}=${c}`).join(", ") || "none"}`);
  console.log(`spent: ${spentTokens} tokens = $${(spentTokens * PRICE_PER_TOKEN).toFixed(2)}`);
  console.log(`contact_photos rows now: ${n}`);
  if (stopped) {
    console.log(`\nSTOPPED EARLY: ${stopped}`);
    console.log(`  ${remaining} of this run's targets were not attempted.`);
  }
  if (totalTargets > targets.length) {
    console.log(
      `  ${totalTargets - targets.length} further targets not covered by --limit; ` +
        `re-run to continue.`,
    );
  }
  if (errors) {
    console.log(`  ${errors} transient failures left unstamped — re-run to retry them.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
