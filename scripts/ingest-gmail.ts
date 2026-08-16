/**
 * Gmail ingest, run from the command line (from web/):
 *
 *   Preview without writing anything:
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-gmail.ts --dry-run
 *
 *   For real, default 12-month window:
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-gmail.ts
 *
 *   Options: --months 24   --max 5000
 *
 * Credentials: the app's Google grant if there is one (Settings → Accounts →
 * Connect Google), else the legacy ~/.mesh-replica/gmail.json from
 * pair-gmail.ts. The reader itself is src/lib/gmail-sync.ts — the same code
 * the daily cron job runs — and it is metadata-only by request shape.
 *
 * Undo with: npx tsx scripts/revert-connector.ts --connector gmail
 */
import { getAccessToken, loadCredentials } from "./gmail-auth";
import { getGoogleCredentials, refreshAccessToken, fetchGmailAddress } from "../src/lib/google-auth";
import { syncGmail } from "../src/lib/gmail-sync";

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const num = (flag: string, dflt: number) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Math.max(parseInt(argv[i + 1] ?? "", 10) || dflt, 1) : dflt;
  };
  const months = num("--months", 12);
  const max = num("--max", 5000);

  // The app's own grant first (Settings → Accounts → Connect Google, or
  // scripts/migrate-gmail-token.ts), then the legacy file on this Mac.
  let token: string;
  let me: string | null;
  const app = await getGoogleCredentials();
  if (app) {
    token = await refreshAccessToken(app);
    me = app.email ?? (await fetchGmailAddress(token));
  } else {
    const creds = loadCredentials();
    if (!creds) {
      console.error(
        "Google isn't connected. Either Settings → Accounts → Connect Google, or run: npx tsx scripts/pair-gmail.ts",
      );
      process.exit(1);
    }
    token = await getAccessToken(creds);
    me = creds.emailAddress?.toLowerCase() ?? (await fetchGmailAddress(token));
  }
  console.log(`Reading ${me || "mailbox"} — last ${months} months, metadata only.`);

  const summary = await syncGmail({
    accessToken: token,
    me: me ?? "",
    window: { months },
    max,
    dryRun,
    log: console.log,
  });
  const { details, ...counts } = summary;
  console.log(JSON.stringify(counts, null, 2));

  if (details.length) {
    console.log(`\n${dryRun ? "Would change" : "Changed"}:`);
    for (const d of details.slice(0, 40)) {
      console.log(`  ${d.contact ?? d.handle} — ${d.note}`);
    }
    if (details.length > 40) console.log(`  … and ${details.length - 40} more`);
  }
  if (dryRun) console.log("\nDry run — nothing was written.");
  if (!summary.ok) process.exit(1);
}

main();
