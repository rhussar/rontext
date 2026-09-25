/**
 * WhatsApp ingest, run from the command line (from web/):
 *
 *   Preview without writing anything:
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-whatsapp.ts --dry-run
 *
 *   For real, default 12 calendar months:
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-whatsapp.ts
 *
 *   Wider window:
 *     ... npx tsx scripts/ingest-whatsapp.ts --months 24
 *
 * Needs WhatsApp for Mac installed and linked to the phone, and **Full Disk
 * Access** for whatever runs this — the store lives in another app's group
 * container, which macOS guards the same way it guards chat.db.
 *
 * The reader is scripts/whatsapp-reader.ts, shared with the nightly launchd
 * agent (scripts/mac-agent.ts) — that's what makes this automatic; this CLI is
 * for previews and wide windows. Also refreshes WhatsApp group-chat links.
 *
 * Undo with: npx tsx scripts/revert-connector.ts --connector whatsapp
 */
import { FULL_DISK_ACCESS_HINT, isFullDiskAccessError } from "./messages-reader";
import { syncWhatsApp } from "./whatsapp-reader";

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const monthsArg = argv.indexOf("--months");
  const months =
    monthsArg >= 0 ? Math.max(parseInt(argv[monthsArg + 1] ?? "12", 10) || 12, 1) : 12;

  let result;
  try {
    result = await syncWhatsApp({ months, dryRun, log: console.log });
  } catch (err) {
    console.error(
      isFullDiskAccessError(err)
        ? FULL_DISK_ACCESS_HINT.replace("chat.db", "WhatsApp's ChatStorage.sqlite")
        : err instanceof Error
          ? err.message
          : err,
    );
    process.exit(1);
  }
  const { details, ...counts } = result.messages;
  console.log(JSON.stringify(counts, null, 2));

  if (details.length) {
    console.log(`\n${dryRun ? "Would change" : "Changed"}:`);
    for (const d of details.slice(0, 40)) {
      console.log(`  ${d.contact ?? d.handle} — ${d.note}`);
    }
    if (details.length > 40) console.log(`  … and ${details.length - 40} more`);
  }
  if ("error" in result.groups) console.error(`\nGroup links failed: ${result.groups.error}`);

  if (dryRun) console.log("\nDry run — nothing was written.");
  if (!result.messages.ok) process.exit(1);
}

main();
