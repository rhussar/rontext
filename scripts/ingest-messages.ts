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
 * Reads a *copy* of ~/Library/Messages/chat.db and never writes to it. Only
 * per-person counts and dates reach Postgres — no message text is read at all,
 * which is enforced by the query below never selecting a text column. Adding
 * the month column below does not change that: it is a date expression over
 * message.date, and neither `text` nor `attributedBody` appears in this file.
 *
 * Counts land two ways: a lifetime total per person in `interactions`, and one
 * bucket per calendar month in `interaction_periods`, which is what lets a
 * person's timeline show "Jul 2026 · 24 texts" without storing 24 rows.
 *
 * Undo with: npx tsx scripts/revert-connector.ts --connector messages
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestHandles,
  type HandleAggregate,
  type PeriodTally,
} from "../src/lib/connector-ingest";

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

/** One row per handle per calendar month. */
type MonthRow = {
  handle: string;
  month: string;
  messageCount: number;
  sentCount: number;
  receivedCount: number;
  firstAt: string;
  lastAt: string;
};

/**
 * Only 1:1 conversations count.
 *
 * Group chats are the main source of junk here — a 30-person thread would
 * otherwise credit you with "talking to" 29 people you've never addressed
 * directly, and every one of them would land in the review queue.
 *
 * Grouped by month as well as handle. The lifetime totals are then summed from
 * these rows in JS rather than queried separately — that's the only way the
 * timeline's per-month rows and the totals can't drift apart.
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
      -- 'start of month' MUST come after 'unixepoch','localtime': SQLite
      -- applies modifiers in order, and reordering these silently yields the
      -- wrong month rather than an error.
      date(${SECONDS_EXPR}, 'unixepoch', 'localtime', 'start of month') AS month,
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
    GROUP BY h.id, month
    ORDER BY h.id, month
  `;
}

/**
 * Fold the month rows up into one aggregate per handle, carrying the months
 * along. Totals are derived, never queried — see query() above.
 */
function foldByHandle(rows: MonthRow[]): HandleAggregate[] {
  const out = new Map<string, HandleAggregate>();
  for (const r of rows) {
    const bucket: PeriodTally = {
      month: r.month,
      messageCount: r.messageCount,
      sentCount: r.sentCount,
      receivedCount: r.receivedCount,
    };
    const prev = out.get(r.handle);
    if (!prev) {
      out.set(r.handle, {
        handle: r.handle,
        messageCount: r.messageCount,
        sentCount: r.sentCount,
        receivedCount: r.receivedCount,
        firstAt: r.firstAt,
        lastAt: r.lastAt,
        periods: [bucket],
      });
      continue;
    }
    prev.messageCount += r.messageCount;
    prev.sentCount += r.sentCount;
    prev.receivedCount += r.receivedCount;
    if (r.firstAt < prev.firstAt) prev.firstAt = r.firstAt;
    if (r.lastAt > prev.lastAt) prev.lastAt = r.lastAt;
    prev.periods!.push(bucket);
  }
  return [...out.values()];
}

/**
 * Start of the month `months - 1` months back, local time.
 *
 * Deliberately not `now - months * 30 days`: that lands mid-month, which makes
 * the oldest bucket a *partial* month whose slice shrinks by a day on every
 * run. Since the upsert keeps the larger count, that bucket would freeze as a
 * permanent high-water mark of an arbitrary partial month and never converge.
 * Snapped, every bucket but the current month is complete and exact.
 */
function windowStart(months: number): number {
  const since = new Date();
  since.setDate(1);
  since.setMonth(since.getMonth() - (months - 1));
  since.setHours(0, 0, 0, 0);
  return Math.floor(since.getTime() / 1000);
}

/**
 * chat.db is WAL-mode and locked while Messages.app is running, so read a copy
 * rather than the live file. Copying the -wal and -shm sidecars keeps recent
 * messages that haven't been checkpointed yet.
 */
function readMonthRows(sinceUnix: number): MonthRow[] {
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
    return out.trim() ? (JSON.parse(out) as MonthRow[]) : [];
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

  const sinceUnix = windowStart(months);

  let monthRows: MonthRow[];
  try {
    monthRows = readMonthRows(sinceUnix);
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

  const rows = foldByHandle(monthRows);
  console.log(
    `Read ${rows.length} handles (${monthRows.length} monthly buckets) from the ` +
      `last ${months} calendar months of 1:1 chats.`,
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
