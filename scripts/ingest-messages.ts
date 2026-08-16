/**
 * Messages (iMessage/SMS) ingest, run from the command line (from web/):
 *
 *   Preview without writing anything:
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-messages.ts --dry-run
 *
 *   For real, default 12 *calendar* months (this month plus the 11 before it,
 *   snapped to month boundaries — see windowStart()):
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-messages.ts
 *
 *   Wider window:
 *     ... npx tsx scripts/ingest-messages.ts --months 24
 *
 * Requires **Full Disk Access** for whatever runs this (Terminal, Claude Code)
 * in System Settings → Privacy & Security. Without it every read of chat.db
 * fails with "authorization denied".
 *
 * The reader itself is scripts/messages-reader.ts, shared with the nightly
 * launchd agent (scripts/mac-agent.ts, installed by install-mac-agent.sh) —
 * that's what makes this automatic; this CLI is for previews and wide windows.
 *
 * Undo with: npx tsx scripts/revert-connector.ts --connector messages
 */
import { FULL_DISK_ACCESS_HINT, isFullDiskAccessError, syncMessages } from "./messages-reader";

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const monthsArg = argv.indexOf("--months");
  const months =
    monthsArg >= 0 ? Math.max(parseInt(argv[monthsArg + 1] ?? "12", 10) || 12, 1) : 12;

  let summary;
  try {
    summary = await syncMessages({ months, dryRun, log: console.log });
  } catch (err) {
    if (isFullDiskAccessError(err)) {
      console.error(FULL_DISK_ACCESS_HINT);
      process.exit(1);
    }
    throw err;
  }
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
