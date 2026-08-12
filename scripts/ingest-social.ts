/**
 * Import a social-sync batch, run from the command line (from web/):
 *
 *   Preview without writing anything:
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-social.ts batch.json --dry-run
 *
 *   For real:
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-social.ts batch.json
 *
 * The batch is written by the social-sync skill (own-account analytics from
 * LinkedIn / X / Instagram). Review it before importing — the file is the
 * whole interface. Undo with: npx tsx scripts/revert-social.ts
 *
 * Import each batch ONCE: metric tables are append-only time series, so a
 * second import of the same file records a duplicate capture.
 */
import { readFileSync } from "node:fs";
import { ingestSocialBatch } from "../src/lib/social-ingest";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: npx tsx scripts/ingest-social.ts <batch.json> [--dry-run]");
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const summary = await ingestSocialBatch(raw, {
    dryRun: args.includes("--dry-run"),
  });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
