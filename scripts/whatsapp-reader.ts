/**
 * The WhatsApp reader — the Messages reader's twin, over WhatsApp for Mac's
 * local database instead of chat.db. Shared by scripts/ingest-whatsapp.ts
 * (CLI) and scripts/mac-agent.ts (the nightly launchd job).
 *
 * Why the desktop app's database and not an API: WhatsApp has no API for a
 * personal account (the Cloud API is Business-only and can't see your own
 * chats), and the unofficial web-client libraries risk getting the number
 * banned. WhatsApp for Mac keeps a Core Data SQLite store of every chat it has
 * synced from the phone, which is exactly the shape chat.db already has here.
 *
 * Same contract as messages-reader.ts: reads a *copy*, never writes, and no
 * text column is ever selected — ZTEXT does not appear in this file. Only
 * per-person counts and dates reach Postgres, as source "whatsapp".
 *
 * Coverage is whatever the Mac app has synced. Linking a new Mac pulls recent
 * history from the phone, not necessarily all of it, so older months can be
 * thinner than on the phone itself.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ingestHandles, type ConnectorSummary } from "../src/lib/connector-ingest";
import { replaceLinks, type LinkSummary } from "../src/lib/contact-links";
import {
  foldByHandle,
  GROUP_MAX_OTHERS,
  GROUP_MIN_MESSAGES,
  GROUP_MIN_OTHERS,
  windowStart,
  withSqliteCopy,
  type MonthRow,
  type SqliteQuery,
} from "./messages-reader";

export const WHATSAPP_DB = join(
  process.env.HOME ?? "",
  "Library",
  "Group Containers",
  "group.net.whatsapp.WhatsApp.shared",
  "ChatStorage.sqlite",
);

/** Installed and linked — the store only appears after the first sync from the phone. */
export function whatsappInstalled(): boolean {
  return existsSync(WHATSAPP_DB);
}

export const NOT_INSTALLED_HINT =
  "WhatsApp for Mac isn't set up on this Mac — install it from the App Store " +
  "(or whatsapp.com/download), link it to your phone, and let it finish syncing.";

/**
 * ZMESSAGEDATE is seconds (a REAL) since 2001-01-01 — Core Data's epoch, same
 * as chat.db's, but never nanoseconds.
 */
const APPLE_EPOCH = 978307200;
const SECONDS_EXPR = `(m.ZMESSAGEDATE + ${APPLE_EPOCH})`;

/**
 * A personal chat's JID is "<country code><number>@s.whatsapp.net". Groups are
 * "@g.us", broadcast lists and Status are "@broadcast", and newer builds use
 * opaque "@lid" ids for some people — those carry no phone number, so they
 * can't be matched to a contact and are skipped rather than guessed at.
 */
const PERSON_JID = "@s.whatsapp.net";
const GROUP_JID = "@g.us";
/** ZMESSAGETYPE 6 is a system row ("X added Y", "security code changed"). */
const SYSTEM_MESSAGE_TYPE = 6;

const jidToPhone = (jid: string) => `+${jid.slice(0, jid.indexOf("@"))}`;

/**
 * Columns this reader depends on. WhatsApp changes its store without notice,
 * and a renamed column would otherwise surface as an opaque sqlite error in
 * the Automation panel — this turns it into one line naming what moved.
 */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  ZWACHATSESSION: ["Z_PK", "ZCONTACTJID", "ZPARTNERNAME"],
  ZWAMESSAGE: ["ZCHATSESSION", "ZISFROMME", "ZMESSAGEDATE", "ZMESSAGETYPE"],
  ZWAGROUPMEMBER: ["ZCHATSESSION", "ZMEMBERJID"],
};

function columnsOf(query: SqliteQuery, table: string): Set<string> {
  return new Set(query<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
}

function checkSchema(query: SqliteQuery): void {
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const have = columnsOf(query, table);
    if (!have.size) missing.push(table);
    else for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  if (missing.length) {
    throw new Error(
      `WhatsApp's database layout changed (missing ${missing.join(", ")}) — ` +
        `scripts/whatsapp-reader.ts needs updating.`,
    );
  }
}

/**
 * 1:1 chats only, one row per person per calendar month — see the long note on
 * the same query in messages-reader.ts for why group chats stay out of the
 * counts and why the month is the grouping unit.
 *
 * The partner name is the name as saved in the phone's address book (or the
 * person's own WhatsApp name), which is what lets an unmatched number arrive
 * in the review queue with a name attached.
 */
function monthQuery(sinceUnix: number): string {
  return `
    SELECT
      s.ZCONTACTJID                                      AS jid,
      MAX(s.ZPARTNERNAME)                                AS displayName,
      -- 'start of month' after 'unixepoch','localtime' — order matters.
      date(${SECONDS_EXPR}, 'unixepoch', 'localtime', 'start of month') AS month,
      COUNT(*)                                           AS messageCount,
      SUM(CASE WHEN m.ZISFROMME = 1 THEN 1 ELSE 0 END)   AS sentCount,
      SUM(CASE WHEN m.ZISFROMME = 1 THEN 0 ELSE 1 END)   AS receivedCount,
      date(MIN(${SECONDS_EXPR}), 'unixepoch', 'localtime') AS firstAt,
      date(MAX(${SECONDS_EXPR}), 'unixepoch', 'localtime') AS lastAt
    FROM ZWAMESSAGE m
    JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
    WHERE s.ZCONTACTJID LIKE '%${PERSON_JID}'
      AND m.ZMESSAGEDATE IS NOT NULL
      AND ${SECONDS_EXPR} >= ${sinceUnix}
      AND COALESCE(m.ZMESSAGETYPE, 0) <> ${SYSTEM_MESSAGE_TYPE}
    GROUP BY s.ZCONTACTJID, month
    ORDER BY s.ZCONTACTJID, month
  `;
}

type RawMonthRow = Omit<MonthRow, "handle"> & { jid: string };

/**
 * Small, active group chats and who is in them — participants only. The
 * member list comes from ZWAGROUPMEMBER, which lists everyone but you; members
 * who left are dropped when the store says so (ZISACTIVE, where present).
 */
function groupQuery(sinceUnix: number, hasIsActive: boolean): string {
  const active = hasIsActive ? "AND COALESCE(gm.ZISACTIVE, 1) = 1" : "";
  return `
    WITH members AS (
      SELECT gm.ZCHATSESSION AS chat, gm.ZMEMBERJID AS jid
      FROM ZWAGROUPMEMBER gm
      JOIN ZWACHATSESSION s ON s.Z_PK = gm.ZCHATSESSION
      WHERE s.ZCONTACTJID LIKE '%${GROUP_JID}' ${active}
    ),
    sized AS (
      SELECT chat FROM members
      GROUP BY chat
      HAVING COUNT(*) BETWEEN ${GROUP_MIN_OTHERS} AND ${GROUP_MAX_OTHERS}
    ),
    activity AS (
      SELECT m.ZCHATSESSION AS chat,
        COUNT(*) AS messages,
        date(MAX(${SECONDS_EXPR}), 'unixepoch', 'localtime') AS lastAt
      FROM ZWAMESSAGE m
      JOIN sized z ON z.chat = m.ZCHATSESSION
      WHERE m.ZMESSAGEDATE IS NOT NULL
        AND ${SECONDS_EXPR} >= ${sinceUnix}
        AND COALESCE(m.ZMESSAGETYPE, 0) <> ${SYSTEM_MESSAGE_TYPE}
      GROUP BY m.ZCHATSESSION
      HAVING COUNT(*) >= ${GROUP_MIN_MESSAGES}
    )
    SELECT a.messages, a.lastAt, json_group_array(mb.jid) AS jids
    FROM activity a
    JOIN members mb ON mb.chat = a.chat
    GROUP BY a.chat
  `;
}

export type WhatsAppSyncSummary = ConnectorSummary & {
  months: number;
  handles: number;
  monthlyBuckets: number;
};

export type WhatsAppGroupLinksSummary = LinkSummary & { months: number };

/**
 * Read `months` calendar months of 1:1 chats and push them through
 * ingestHandles(), then refresh the whatsapp_group links from a `groupMonths`
 * window — both from one copy of the store. Throws when the store is missing
 * or unreadable; callers decide whether that's a printed hint or a heartbeat.
 */
export async function syncWhatsApp(opts: {
  months?: number;
  groupMonths?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}): Promise<{ messages: WhatsAppSyncSummary; groups: WhatsAppGroupLinksSummary | { error: string } }> {
  if (!whatsappInstalled()) throw new Error(NOT_INSTALLED_HINT);
  const months = Math.max(opts.months ?? 12, 1);
  const groupMonths = Math.max(opts.groupMonths ?? 36, 1);
  const log = opts.log ?? (() => {});

  const { raw, groupRows } = withSqliteCopy(WHATSAPP_DB, (query) => {
    checkSchema(query);
    const hasIsActive = columnsOf(query, "ZWAGROUPMEMBER").has("ZISACTIVE");
    return {
      raw: query<RawMonthRow>(monthQuery(windowStart(months))),
      groupRows: query<{ messages: number; lastAt: string; jids: string }>(
        groupQuery(windowStart(groupMonths), hasIsActive),
      ),
    };
  });

  const monthRows: MonthRow[] = raw.map(({ jid, ...r }) => ({ ...r, handle: jidToPhone(jid) }));
  const rows = foldByHandle(monthRows);
  log(
    `Read ${rows.length} WhatsApp chats (${monthRows.length} monthly buckets) from the ` +
      `last ${months} calendar months of 1:1 chats.`,
  );
  const s = await ingestHandles("whatsapp", "whatsapp", rows, { dryRun: opts.dryRun });
  const messages = { ...s, months, handles: rows.length, monthlyBuckets: monthRows.length };

  // Its own try, as in the Messages pass: a problem with group links must not
  // turn a successful 1:1 sync into a failure.
  let groups: WhatsAppGroupLinksSummary | { error: string };
  try {
    const threads = groupRows.map((r) => ({
      handles: (JSON.parse(r.jids) as string[])
        .filter((j) => j?.endsWith(PERSON_JID))
        .map(jidToPhone),
      messages: r.messages,
      lastAt: r.lastAt,
    }));
    const g = await replaceLinks("whatsapp_group", threads, { dryRun: opts.dryRun });
    log(
      `WhatsApp groups: ${g.threads} active in the last ${groupMonths} months, ${g.usableThreads} with 2+ contacts → ` +
        `${g.pairs} pairs across ${g.people} people.`,
    );
    groups = { ...g, months: groupMonths };
  } catch (err) {
    groups = { error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }

  return { messages, groups };
}
