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
 * The lookup loop itself lives in src/lib/photo-backfill.ts and is shared with
 * the scheduled job (src/lib/jobs/photos.ts), which runs the same thing daily
 * under a monthly budget from Settings. This CLI remains for bulk one-offs,
 * --revert and --force. Only public LinkedIn slugs leave the machine — no
 * names, emails, or credentials.
 *
 * Why misses are classified by content type and not status code is explained
 * at the top of src/lib/photo-backfill.ts (the grey-ghost SVG problem).
 */
import { eq, inArray, notInArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactPhotos, contacts } from "../src/db/schema";
import { getSecret } from "../src/lib/secrets";
import {
  backfillPhotos,
  HARD_CAP_USD,
  photoTargets,
  PRICE_PER_TOKEN,
} from "../src/lib/photo-backfill";

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
        `Raise HARD_CAP_USD in src/lib/photo-backfill.ts if that is genuinely intended.`,
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

  const { targets: all, candidates, noSlug } = await photoTargets(opts);
  const targets = opts.limit ? all.slice(0, opts.limit) : all;

  console.log(`candidates:            ${candidates}`);
  console.log(`  no /in/ slug:        ${noSlug}`);
  console.log(`  distinct slugs:      ${all.length}`);
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

  const s = await backfillPhotos({ ...opts, apiKey, log: console.log });

  const db = getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(contactPhotos);

  console.log(`\nhits ${s.hits} · misses ${s.misses} · errors ${s.errors}`);
  console.log(
    `proxy tiers: ${Object.entries(s.tiers).map(([t, c]) => `${t}=${c}`).join(", ") || "none"}`,
  );
  console.log(`spent: ${s.spentTokens} tokens = $${s.spentUsd.toFixed(2)}`);
  console.log(`contact_photos rows now: ${n}`);
  if (s.stopped) {
    console.log(`\nSTOPPED EARLY: ${s.stopped}`);
    console.log(`  ${s.remaining} of this run's targets were not attempted.`);
  }
  if (all.length > targets.length) {
    console.log(
      `  ${all.length - targets.length} further targets not covered by --limit; ` +
        `re-run to continue.`,
    );
  }
  if (s.errors) {
    console.log(`  ${s.errors} transient failures left unstamped — re-run to retry them.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
