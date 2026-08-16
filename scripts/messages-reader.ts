/**
 * The Messages (iMessage/SMS) reader, shared by scripts/ingest-messages.ts
 * (CLI) and scripts/mac-agent.ts (the nightly launchd job). Mac-only by
 * nature — it reads ~/Library/Messages/chat.db through the system sqlite3 —
 * so it lives in scripts/, never under src/, and can never run on Vercel.
 *
 * Reads a *copy* of chat.db and never writes to it. Only per-person counts and
 * dates reach Postgres — no message text is read at all, which is enforced by
 * the query below never selecting a text column. Adding the month column does
 * not change that: it is a date expression over message.date, and neither
 * `text` nor `attributedBody` appears in this file.
 *
 * Counts land two ways: a lifetime total per person in `interactions`, and one
 * bucket per calendar month in `interaction_periods`, which is what lets a
 * person's timeline show "Jul 2026 · 24 texts" without storing 24 rows.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestHandles,
  type ConnectorSummary,
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


export type MessagesSyncSummary = ConnectorSummary & {
  months: number;
  handles: number;
  monthlyBuckets: number;
};

/** True when the error is macOS refusing to open chat.db — i.e. no Full Disk Access. */
export function isFullDiskAccessError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /authorization denied|unable to open|operation not permitted/i.test(msg);
}

export const FULL_DISK_ACCESS_HINT =
  "Cannot read chat.db — grant Full Disk Access to whatever runs this " +
  "(System Settings → Privacy & Security → Full Disk Access), then retry.";

/**
 * Read `months` calendar months of 1:1 chats and push them through
 * ingestHandles(). Throws on a chat.db read failure — callers decide whether
 * that's a printed hint (CLI) or a failed heartbeat (agent).
 */
export async function syncMessages(opts: {
  months?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}): Promise<MessagesSyncSummary> {
  const months = Math.max(opts.months ?? 12, 1);
  const log = opts.log ?? (() => {});
  const monthRows = readMonthRows(windowStart(months));
  const rows = foldByHandle(monthRows);
  log(
    `Read ${rows.length} handles (${monthRows.length} monthly buckets) from the ` +
      `last ${months} calendar months of 1:1 chats.`,
  );
  const summary = await ingestHandles("messages", "messages", rows, { dryRun: opts.dryRun });
  return { ...summary, months, handles: rows.length, monthlyBuckets: monthRows.length };
}
