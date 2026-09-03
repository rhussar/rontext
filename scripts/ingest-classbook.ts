/**
 * Import "Get to Know Your Class" classbook profiles from a JSON batch.
 *
 *   set -a && source .env.local && set +a && \
 *     npx tsx scripts/ingest-classbook.ts <batch.json> --cohort Red [--dry-run]
 *
 * The batch is an array of ClassbookProfile (see src/lib/classbook-ingest.ts).
 * Matching: explicit matchContactId → exact full name → unique bare first
 * name already in the cohort group. Everything else creates a new contact
 * (source "import", interactionSources ["classbook"]). Fill-gaps only; safe
 * to re-run. Undo with scripts/revert-classbook.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ingestClassbookProfiles, type ClassbookProfile } from "../src/lib/classbook-ingest";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run:");
    console.error("  set -a && source .env.local && set +a && npx tsx scripts/ingest-classbook.ts <batch.json> --cohort <name>");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const cohortIdx = args.indexOf("--cohort");
  const cohort = cohortIdx >= 0 ? args[cohortIdx + 1] : undefined;
  const extraGroups: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--also-group" && args[i + 1]) extraGroups.push(args[i + 1]);
  }
  const path = args.find(
    (a) => !a.startsWith("--") && a !== cohort && !extraGroups.includes(a),
  );
  if (!path || !cohort) {
    console.error(
      "Usage: ingest-classbook.ts <batch.json> --cohort <name> [--also-group <name>]... [--dry-run]",
    );
    process.exit(1);
  }
  const profiles = JSON.parse(readFileSync(resolve(path), "utf8")) as ClassbookProfile[];
  if (!Array.isArray(profiles)) {
    console.error("Batch file must be a JSON array of profiles");
    process.exit(1);
  }
  const summary = await ingestClassbookProfiles(profiles, { cohort, dryRun, extraGroups });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main();
