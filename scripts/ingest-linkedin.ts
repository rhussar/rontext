/**
 * LinkedIn scrape ingest, run from the command line (from web/):
 *
 *   Select next profiles due for a refresh (starred first, then stalest):
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-linkedin.ts --select [N]
 *
 *   Ingest a scraped batch (JSON array of ScrapedProfile):
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-linkedin.ts <batch.json>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, desc, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import {
  ingestLinkedinProfiles,
  type ScrapedProfile,
} from "../src/lib/linkedin-ingest";

async function select(n: number) {
  const db = getDb();
  const rows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      linkedinUrl: contacts.linkedinUrl,
      starred: contacts.starred,
      lastScrapedAt: contacts.lastScrapedAt,
    })
    .from(contacts)
    .where(and(isNotNull(contacts.linkedinUrl), isNull(contacts.archivedAt)))
    .orderBy(desc(contacts.starred), sql`${contacts.lastScrapedAt} ASC NULLS FIRST`)
    .limit(n);
  console.log(JSON.stringify(rows, null, 2));
}

async function ingest(path: string) {
  const raw = readFileSync(resolve(path), "utf8");
  const profiles: ScrapedProfile[] = JSON.parse(raw);
  if (!Array.isArray(profiles)) {
    console.error("Batch file must be a JSON array of ScrapedProfile objects");
    process.exit(1);
  }
  const summary = await ingestLinkedinProfiles(profiles);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Usage: tsx scripts/ingest-linkedin.ts --select [N] | <batch.json>",
    );
    process.exit(1);
  }
  if (arg === "--select") {
    const n = Math.min(Math.max(parseInt(process.argv[3] ?? "25", 10) || 25, 1), 50);
    await select(n);
  } else {
    await ingest(arg);
  }
}

main();
