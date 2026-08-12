/**
 * GitHub stats sync, run from the command line (from web/):
 *
 *   Preview without writing anything:
 *     set -a && source .env.local && set +a && npx tsx scripts/sync-github.ts --dry-run
 *
 *   For real:
 *     set -a && source .env.local && set +a && npx tsx scripts/sync-github.ts
 *
 *   Options: --repos rhussar/rontext,rhussar/other   (limit traffic pull)
 *
 * Needs GITHUB_TOKEN in .env.local — a PAT with read access to your repos.
 * Traffic endpoints (views/clones) require PUSH access and only return a
 * rolling 14-day window: run this at least weekly or the older days are gone
 * for good. Re-running the same day is safe — (repo, day) rows upsert.
 */
import { syncGithub } from "../src/lib/github-ingest";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const reposIdx = args.indexOf("--repos");
  const repos =
    reposIdx !== -1 && args[reposIdx + 1]
      ? args[reposIdx + 1].split(",").map((r) => r.trim()).filter(Boolean)
      : undefined;

  const summary = await syncGithub({ dryRun, repos });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
