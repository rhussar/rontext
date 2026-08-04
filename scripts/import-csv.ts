/**
 * Run the CSV import from the command line:
 *   set -a && source .env.local && set +a && npx tsx scripts/import-csv.ts <path-to-csv>
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { importCsvText } from "../src/lib/import-core";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: tsx scripts/import-csv.ts <path-to-csv>");
    process.exit(1);
  }
  const path = resolve(arg);
  const text = readFileSync(path, "utf8");
  const summary = await importCsvText(text, basename(path));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main();
