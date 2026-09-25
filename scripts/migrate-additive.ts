/**
 * `prebuild` hook: apply drizzle/additive/*.sql before `next build`.
 * See src/db/additive-sync.ts for what may go in there and why.
 *
 * On Vercel a missing DATABASE_URL fails the build: shipping code whose
 * tables may not exist is worse than not shipping. Locally, with no
 * DATABASE_URL, it's a no-op so `npm run build` still works offline.
 */
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";
import { applyAdditive, loadAdditive } from "../src/db/additive-sync";

async function main() {
  // Parse first: a bad file fails the build even where there's no database.
  const statements = loadAdditive(join(process.cwd(), "drizzle", "additive"));

  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.VERCEL) {
      console.error("[schema] DATABASE_URL is not set for this build — refusing to deploy without the schema check.");
      process.exit(1);
    }
    console.log("[schema] DATABASE_URL not set — skipping (local build).");
    return;
  }
  if (process.env.SKIP_SCHEMA_SYNC === "1") {
    console.log("[schema] SKIP_SCHEMA_SYNC=1 — skipping.");
    return;
  }

  const sql = neon(url);
  const n = await applyAdditive(statements, (s) => sql.query(s));
  console.log(`[schema] ${n} additive statements ensured`);
}

main().catch((e) => {
  console.error(`[schema] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
