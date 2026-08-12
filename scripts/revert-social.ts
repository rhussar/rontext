/**
 * Undo social-sync imports, run from the command line (from web/):
 *
 *   Preview what would be deleted:
 *     set -a && source .env.local && set +a && npx tsx scripts/revert-social.ts --dry-run
 *
 *   Delete all scraped social metrics:
 *     set -a && source .env.local && set +a && npx tsx scripts/revert-social.ts
 *
 *   One platform only:
 *     npx tsx scripts/revert-social.ts --platform x
 *
 * Provenance-scoped: only rows with source='scrape' are deleted. GitHub rows
 * (source='api', written by scripts/sync-github.ts) are never touched — there
 * is deliberately no revert for those, since the 14-day traffic window makes
 * them unrecoverable.
 */
import { revertSocialScrapes } from "../src/lib/social-ingest";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "../src/db/schema";

async function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  let platform: SocialPlatform | undefined;
  if (platIdx !== -1) {
    const value = args[platIdx + 1] as SocialPlatform;
    if (!SOCIAL_PLATFORMS.includes(value)) {
      console.error(`--platform must be one of: ${SOCIAL_PLATFORMS.join(", ")}`);
      process.exit(1);
    }
    platform = value;
  }
  const summary = await revertSocialScrapes({
    platform,
    dryRun: args.includes("--dry-run"),
  });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
