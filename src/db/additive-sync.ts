/**
 * Bring the database up to the schema — additive changes only.
 *
 * Runs before every Vercel build (scripts/migrate-additive.ts, the `prebuild`
 * hook), so code that needs a new table or column never goes live against a
 * database that lacks it. Until this existed, every schema change needed
 * someone to remember `npm run db:push` before the deploy, and forgetting
 * broke every page that read the changed table.
 *
 * It asks drizzle-kit for exactly the statements `db:push` would run, then
 * applies only the ones that can't lose data: creating tables, indexes,
 * extensions, sequences, types; adding columns and constraints. Anything else
 * — a drop, a rename, a type change — is printed and left alone for a human
 * running `db:push` interactively, because that is where data loss lives and
 * a build has nobody to ask.
 *
 * Idempotent: once the database matches, the plan is empty.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { pushSchema } from "drizzle-kit/api";
import * as schema from "./schema";

const ADDITIVE = [
  /^CREATE TABLE\b/i,
  /^CREATE (UNIQUE )?INDEX\b/i,
  /^CREATE EXTENSION\b/i,
  /^CREATE SCHEMA\b/i,
  /^CREATE SEQUENCE\b/i,
  /^CREATE TYPE\b/i,
  /^ALTER TABLE \S+ ADD COLUMN\b/i,
  /^ALTER TABLE \S+ ADD CONSTRAINT\b/i,
  // drizzle wraps foreign keys in a DO block that swallows duplicate_object
  /^DO \$\$ BEGIN\s+ALTER TABLE \S+ ADD CONSTRAINT\b/i,
];

/** Postgres codes for "that already exists" — harmless drift, not a failure. */
const ALREADY_EXISTS = new Set(["42P07", "42710", "42701", "42P06", "42P16"]);

export function isAdditive(statement: string): boolean {
  const s = statement.trim();
  // "ADD COLUMN ... NOT NULL" without a default fails on a non-empty table;
  // it's still additive, and if it fails the build stops, which is the point.
  return ADDITIVE.some((re) => re.test(s));
}

export type SyncReport = {
  applied: string[];
  alreadyThere: string[];
  /** Non-additive changes db:push would make. Printed, never applied here. */
  skipped: string[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function syncAdditive(db: PgDatabase<any>, log: (line: string) => void): Promise<SyncReport> {
  const plan = await pushSchema(schema as Record<string, unknown>, db);
  const report: SyncReport = { applied: [], alreadyThere: [], skipped: [] };

  for (const statement of plan.statementsToExecute) {
    if (!isAdditive(statement)) {
      report.skipped.push(statement);
      continue;
    }
    try {
      await db.execute(sql.raw(statement));
      report.applied.push(statement);
      log(`applied: ${oneLine(statement)}`);
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } }).code ??
        (e as { cause?: { code?: string } }).cause?.code;
      if (code && ALREADY_EXISTS.has(code)) {
        report.alreadyThere.push(statement);
        continue;
      }
      throw new Error(`Schema sync failed on: ${oneLine(statement)}\n${(e as Error).message}`);
    }
  }

  for (const s of report.skipped) {
    log(`NOT applied (not additive — run \`npm run db:push\` to review): ${oneLine(s)}`);
  }
  return report;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 240);
