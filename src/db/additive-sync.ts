/**
 * Apply the checked-in additive migrations in drizzle/additive/, in order.
 *
 * Runs before every Vercel build (scripts/migrate-additive.ts, the `prebuild`
 * hook), so code that needs a new table or column never goes live against a
 * database that lacks it. Before this, every schema change needed someone to
 * remember `npm run db:push` before the deploy, and forgetting broke every
 * page that read the changed table.
 *
 * Each file is a `drizzle-kit generate` diff made idempotent, so re-running it
 * on every build is a no-op once applied — no ledger table needed. And each
 * statement must be one of the forms that can't lose data; anything else
 * (a DROP, a type change, a rename) is refused and fails the build, because
 * that belongs in an interactive `db:push` with a human reading the diff.
 *
 * `db:push` stays the tool for local work and anything non-additive. To ship
 * an additive schema change: `drizzle-kit generate` against main's schema,
 * make it idempotent like 0001, and add it here as the next file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = [
  /^CREATE TABLE IF NOT EXISTS\b/i,
  /^CREATE (UNIQUE )?INDEX IF NOT EXISTS\b/i,
  /^CREATE EXTENSION IF NOT EXISTS\b/i,
  /^ALTER TABLE \S+ ADD COLUMN IF NOT EXISTS\b/i,
  /^DO \$\$ BEGIN\s+ALTER TABLE \S+ ADD CONSTRAINT\b[\s\S]*EXCEPTION WHEN duplicate_object THEN NULL;\s*END \$\$;?$/i,
];

export type AdditiveStatement = { file: string; statement: string };

/** Comment lines are documentation, not SQL; the breakpoint marker is drizzle's own. */
export function parseAdditive(file: string, text: string): AdditiveStatement[] {
  return text
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean)
    .map((statement) => {
      if (!ALLOWED.some((re) => re.test(statement))) {
        throw new Error(
          `${file}: not an idempotent additive statement, refusing to run it at build time:\n${statement.slice(0, 300)}`,
        );
      }
      return { file, statement };
    });
}

export function loadAdditive(dir: string): AdditiveStatement[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => parseAdditive(f, readFileSync(join(dir, f), "utf8")));
}

export async function applyAdditive(
  statements: AdditiveStatement[],
  exec: (statement: string) => Promise<unknown>,
): Promise<number> {
  for (const { file, statement } of statements) {
    try {
      await exec(statement);
    } catch (e) {
      throw new Error(`${file}: ${(e as Error).message}\n  in: ${statement.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  return statements.length;
}
