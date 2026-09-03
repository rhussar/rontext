/**
 * Undo a classbook import (see scripts/ingest-classbook.ts).
 *
 *   set -a && source .env.local && set +a && \
 *     npx tsx scripts/revert-classbook.ts --cohort Red [--dry-run]
 *
 * Deletes every contact any classbook import created (source "import" +
 * interactionSources contains "classbook" — cascade removes their notes,
 * education, and group links) and the "Yale SOM classbook (<cohort> Cohort)"
 * notes added to pre-existing contacts. Name/hometown fills and education
 * rows on matched contacts are deliberately left in place.
 */
import { revertClassbook } from "../src/lib/classbook-ingest";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — source .env.local first.");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const cohortIdx = args.indexOf("--cohort");
  const cohort = cohortIdx >= 0 ? args[cohortIdx + 1] : undefined;
  if (!cohort) {
    console.error("Usage: revert-classbook.ts --cohort <name> [--dry-run]");
    process.exit(1);
  }
  const result = await revertClassbook({ cohort, dryRun: args.includes("--dry-run") });
  console.log(JSON.stringify(result, null, 2));
}

main();
