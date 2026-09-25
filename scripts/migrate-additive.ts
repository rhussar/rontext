/**
 * `prebuild` hook: apply additive schema changes before `next build`.
 * See src/db/additive-sync.ts for what counts as additive and why.
 *
 * On Vercel a missing DATABASE_URL fails the build: shipping code whose
 * tables may not exist is worse than not shipping. Locally, with no
 * DATABASE_URL, it's a no-op so `npm run build` still works offline.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { syncAdditive } from "../src/db/additive-sync";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.VERCEL) {
      console.error("[schema] DATABASE_URL is not set for this build — refusing to deploy without a schema check.");
      process.exit(1);
    }
    console.log("[schema] DATABASE_URL not set — skipping schema sync (local build).");
    return;
  }
  if (process.env.SKIP_SCHEMA_SYNC === "1") {
    console.log("[schema] SKIP_SCHEMA_SYNC=1 — skipping schema sync.");
    return;
  }

  const report = await syncAdditive(drizzle(neon(url)), (line) => console.log(`[schema] ${line}`));
  console.log(
    `[schema] ${report.applied.length} applied, ${report.alreadyThere.length} already there, ${report.skipped.length} left for db:push`,
  );
}

main().catch((e) => {
  console.error(`[schema] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
