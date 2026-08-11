/**
 * Messages (iMessage/SMS) ingest, run from the command line (from web/):
 *
 *   Preview without writing anything:
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-messages.ts --dry-run
 *
 *   For real, default 12-month window:
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-messages.ts
 *
 *   Wider window:
 *     ... npx tsx scripts/ingest-messages.ts --months 24
 *
 * Requires **Full Disk Access** for whatever runs this (Terminal, Claude Code)
 * in System Settings → Privacy & Security. Without it every read of chat.db
 * fails with "authorization denied".
 *
 * Reads a *copy* of ~/Library/Messages/chat.db and never writes to it. Only
 * per-person counts and dates reach Postgres — no message text is read at all,
 * which is enforced by the query below never selecting a text column.
 *
 * Undo with: npx tsx scripts/revert-connector.ts --connector messages
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestHandles, type HandleAggregate } from "../src/lib/connector-ingest";

const CHAT_DB = join(
  process.env.HOME ?? "",
  "Library",
  "Messages",
  "chat.db",
);

/**
 * Apple stores message.date as nanoseconds since 2001-01-01, but rows written
 * before macOS 10.13 use seconds. The CASE picks the right scale per row rather
 * than assuming the whole database is modern.
 */
const APPLE_EPOCH = 978307200;
const SECONDS_EXPR = `(CASE WHEN m.date > 100000000000 THEN m.date / 1000000000 ELSE m.date END + ${APPLE_EPOCH})`;

/**
 * Only 1:1 conversations count.
 *
 * Group chats are the main source of junk here — a 30-person thread would
 * otherwise credit you with "talking to" 29 people you've never addressed
 * directly, and every one of them would land in the review queue.
 */
function query(sinceUnix: number): string {
  return `
    WITH one_on_one AS (
      SELECT chat_id, MIN(handle_id) AS handle_id
      FROM chat_handle_join
      GROUP BY chat_id
      HAVING COUNT(*) = 1
    )
    SELECT
      h.id                                          AS handle,
      COUNT(*)                                      AS messageCount,
      SUM(m.is_from_me)                             AS sentCount,
      SUM(1 - m.is_from_me)                         AS receivedCount,
      date(MIN(${SECONDS_EXPR}), 'unixepoch', 'localtime') AS firstAt,
      date(MAX(${SECONDS_EXPR}), 'unixepoch', 'localtime') AS lastAt
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN one_on_one o          ON o.chat_id = cmj.chat_id
    JOIN handle h              ON h.ROWID = o.handle_id
    WHERE ${SECONDS_EXPR} >= ${sinceUnix}
      AND m.associated_message_type = 0  -- skip tapbacks/reactions
      AND m.item_type = 0                -- skip "X renamed the group" events
    GROUP BY h.id
  `;
}

/**
 * chat.db is WAL-mode and locked while Messages.app is running, so read a copy
 * rather than the live file. Copying the -wal and -shm sidecars keeps recent
 * messages that haven't been checkpointed yet.
 */
function readAggregates(sinceUnix: number): HandleAggregate[] {
  if (!existsSync(CHAT_DB)) {
    throw new Error(`No Messages database at ${CHAT_DB}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "mesh-messages-"));
  try {
    const copy = join(dir, "chat.db");
    copyFileSync(CHAT_DB, copy);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(CHAT_DB + ext)) copyFileSync(CHAT_DB + ext, copy + ext);
    }

    // The system sqlite3 CLI rather than a native npm module: this script can
    // never run on Vercel, and adding better-sqlite3 would drag a native build
    // into the deployed package for no reason.
    const out = execFileSync(
      "/usr/bin/sqlite3",
      ["-readonly", "-json", copy, query(sinceUnix)],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return out.trim() ? (JSON.parse(out) as HandleAggregate[]) : [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const monthsArg = argv.indexOf("--months");
  const months =
    monthsArg >= 0 ? Math.max(parseInt(argv[monthsArg + 1] ?? "12", 10) || 12, 1) : 12;

  const sinceUnix = Math.floor(Date.now() / 1000) - months * 30 * 24 * 60 * 60;

  let rows: HandleAggregate[];
  try {
    rows = readAggregates(sinceUnix);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/authorization denied|unable to open/i.test(msg)) {
      console.error(
        "Cannot read chat.db — grant Full Disk Access to this terminal in\n" +
          "System Settings → Privacy & Security → Full Disk Access, then retry.",
      );
      process.exit(1);
    }
    throw err;
  }

  console.log(
    `Read ${rows.length} handles from the last ${months} months of 1:1 chats.`,
  );

  const summary = await ingestHandles("messages", "messages", rows, { dryRun });
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
