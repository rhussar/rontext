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
  readSqliteCopy,
  windowStart,
  withSqliteCopy,
  type MonthRow,
  type SqliteQuery,
} from "./messages-reader";

const CONTAINER = join(
  process.env.HOME ?? "",
  "Library",
  "Group Containers",
  "group.net.whatsapp.WhatsApp.shared",
);
export const WHATSAPP_DB = join(CONTAINER, "ChatStorage.sqlite");
/** Hidden-number id ↔ phone pairs WhatsApp has learned. */
const LID_DB = join(CONTAINER, "LID.sqlite");
/** WhatsApp's copy of the phone's address book, which also carries each entry's LID. */
const CONTACTS_DB = join(CONTAINER, "ContactsV2.sqlite");

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
export const WA_SECONDS_EXPR = `(m.ZMESSAGEDATE + ${APPLE_EPOCH})`;
const SECONDS_EXPR = WA_SECONDS_EXPR;

/**
 * A personal chat's JID is "<country code><number>@s.whatsapp.net". Groups are
 * "@g.us", broadcast lists and Status are "@broadcast". Newer builds address
 * most people by an opaque "@lid" id instead (two-thirds of 1:1 chats on the
 * owner's Mac in Sep 2026) — those are resolved to a number through
 * LID.sqlite and ContactsV2.sqlite, and dropped when neither knows it rather
 * than guessed at: a LID's digits are not a phone number.
 */
export const PERSON_JID = "@s.whatsapp.net";
export const LID_JID = "@lid";
const GROUP_JID = "@g.us";
/** ZMESSAGETYPE 6 is a system row ("X added Y", "security code changed"). */
export const SYSTEM_MESSAGE_TYPE = 6;

/** "+14155550101" from "14155550101@s.whatsapp.net", "+1 415…" or "14155550101"; null if too short. */
function toPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.indexOf("@");
  const digits = (at >= 0 ? value.slice(0, at) : value).replace(/\D/g, "");
  return digits.length >= 7 ? `+${digits}` : null;
}

/** Person JID (phone or LID) → "+<digits>", or null when it can't be resolved. */
export type JidResolver = (jid: string | null | undefined) => string | null;

/**
 * Build the LID → phone map from every place WhatsApp keeps one. Each source
 * is optional: a missing file or a changed layout just means fewer LIDs
 * resolve, which the sync reports as a count rather than failing on.
 *
 * The chat table itself is the best source: each 1:1 session carries the
 * person's *other* id in ZCONTACTIDENTIFIER — the phone JID on a LID-addressed
 * chat, the LID on a phone-addressed one. On the owner's Mac that resolved
 * every LID chat, including people who aren't in the phone's address book
 * (whom ContactsV2 never has) while LID.sqlite was still empty.
 */
export function loadJidResolver(): { resolve: JidResolver; knownLids: number } {
  const lids = new Map<string, string>();
  const tryRead = (path: string, sql: string) => {
    if (!existsSync(path)) return;
    try {
      for (const r of readSqliteCopy<{ lid: string; phone: string }>(path, sql)) {
        const phone = toPhone(r.phone);
        if (r.lid && phone && !lids.has(r.lid)) lids.set(r.lid, phone);
      }
    } catch (err) {
      console.error(`WhatsApp LID map: skipped ${path}: ${err instanceof Error ? err.message : err}`);
    }
  };
  tryRead(
    WHATSAPP_DB,
    `SELECT
       CASE WHEN ZCONTACTJID LIKE '%${LID_JID}' THEN ZCONTACTJID ELSE ZCONTACTIDENTIFIER END AS lid,
       CASE WHEN ZCONTACTJID LIKE '%${LID_JID}' THEN ZCONTACTIDENTIFIER ELSE ZCONTACTJID END AS phone
     FROM ZWACHATSESSION
     WHERE (ZCONTACTJID LIKE '%${LID_JID}' AND ZCONTACTIDENTIFIER LIKE '%${PERSON_JID}')
        OR (ZCONTACTJID LIKE '%${PERSON_JID}' AND ZCONTACTIDENTIFIER LIKE '%${LID_JID}')`,
  );
  tryRead(LID_DB, "SELECT ZLID AS lid, ZPHONENUMBER AS phone FROM ZWAPHONENUMBERLIDPAIR");
  tryRead(
    CONTACTS_DB,
    "SELECT ZLID AS lid, COALESCE(ZWHATSAPPID, ZPHONENUMBER) AS phone FROM ZWAADDRESSBOOKCONTACT WHERE ZLID IS NOT NULL",
  );
  const resolve: JidResolver = (jid) => {
    if (!jid) return null;
    if (jid.endsWith(PERSON_JID)) return toPhone(jid);
    if (jid.endsWith(LID_JID)) return lids.get(jid) ?? null;
    return null;
  };
  return { resolve, knownLids: lids.size };
}

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
 * The partner name is the name as saved in the phone's address book. For
 * someone who isn't in it, WhatsApp shows their formatted number there
 * instead, so the person's own WhatsApp profile name ("push name") is read
 * alongside as the fallback — see displayNameOf(). That is what lets an
 * unmatched number arrive in the review queue with a name attached.
 */
function monthQuery(sinceUnix: number, hasPushNames: boolean): string {
  const pushName = hasPushNames
    ? `(SELECT MAX(p.ZPUSHNAME) FROM ZWAPROFILEPUSHNAME p
        WHERE p.ZJID IN (s.ZCONTACTJID, s.ZCONTACTIDENTIFIER))`
    : "NULL";
  return `
    SELECT
      s.ZCONTACTJID                                      AS jid,
      MAX(s.ZPARTNERNAME)                                AS partnerName,
      MAX(${pushName})                                   AS pushName,
      -- 'start of month' after 'unixepoch','localtime' — order matters.
      date(${SECONDS_EXPR}, 'unixepoch', 'localtime', 'start of month') AS month,
      COUNT(*)                                           AS messageCount,
      SUM(CASE WHEN m.ZISFROMME = 1 THEN 1 ELSE 0 END)   AS sentCount,
      SUM(CASE WHEN m.ZISFROMME = 1 THEN 0 ELSE 1 END)   AS receivedCount,
      date(MIN(${SECONDS_EXPR}), 'unixepoch', 'localtime') AS firstAt,
      date(MAX(${SECONDS_EXPR}), 'unixepoch', 'localtime') AS lastAt
    FROM ZWAMESSAGE m
    JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
    WHERE (s.ZCONTACTJID LIKE '%${PERSON_JID}' OR s.ZCONTACTJID LIKE '%${LID_JID}')
      AND m.ZMESSAGEDATE IS NOT NULL
      AND ${SECONDS_EXPR} >= ${sinceUnix}
      AND COALESCE(m.ZMESSAGETYPE, 0) <> ${SYSTEM_MESSAGE_TYPE}
    GROUP BY s.ZCONTACTJID, month
    ORDER BY s.ZCONTACTJID, month
  `;
}

type RawMonthRow = Omit<MonthRow, "handle" | "displayName"> & {
  jid: string;
  partnerName: string | null;
  pushName: string | null;
};

/** Unicode direction marks WhatsApp wraps displayed numbers in (U+200E/F, U+202A–E, U+2066–9). */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * The address-book name when there is one, else their WhatsApp profile name.
 * A "name" with no letters in it is just the number WhatsApp displays for
 * someone not in the address book — worse than no name in the review queue.
 */
function displayNameOf(r: { partnerName: string | null; pushName: string | null }): string | null {
  const clean = (v: string | null) => v?.replace(BIDI, "").trim() || null;
  const hasLetters = (v: string | null) => !!v && /\p{L}/u.test(v);
  const partner = clean(r.partnerName);
  if (hasLetters(partner)) return partner;
  const push = clean(r.pushName);
  return hasLetters(push) ? push : null;
}

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
  /** Hidden-number (LID) chats neither LID map could resolve to a phone. */
  unresolvedChats: number;
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
    const pushCols = columnsOf(query, "ZWAPROFILEPUSHNAME");
    const hasPushNames =
      pushCols.has("ZJID") &&
      pushCols.has("ZPUSHNAME") &&
      columnsOf(query, "ZWACHATSESSION").has("ZCONTACTIDENTIFIER");
    return {
      raw: query<RawMonthRow>(monthQuery(windowStart(months), hasPushNames)),
      groupRows: query<{ messages: number; lastAt: string; jids: string }>(
        groupQuery(windowStart(groupMonths), hasIsActive),
      ),
    };
  });

  const { resolve } = loadJidResolver();
  const unresolved = new Set<string>();
  const monthRows: MonthRow[] = [];
  for (const { jid, partnerName, pushName, ...r } of raw) {
    const handle = resolve(jid);
    if (handle) monthRows.push({ ...r, handle, displayName: displayNameOf({ partnerName, pushName }) });
    else unresolved.add(jid);
  }
  // Folding by phone also merges a person's old number-addressed chat with
  // their newer LID-addressed one.
  const rows = foldByHandle(monthRows);
  log(
    `Read ${rows.length} WhatsApp chats (${monthRows.length} monthly buckets) from the ` +
      `last ${months} calendar months of 1:1 chats` +
      (unresolved.size ? `; ${unresolved.size} hidden-number chats not resolvable yet.` : "."),
  );
  const s = await ingestHandles("whatsapp", "whatsapp", rows, { dryRun: opts.dryRun });
  const messages = {
    ...s,
    months,
    handles: rows.length,
    monthlyBuckets: monthRows.length,
    unresolvedChats: unresolved.size,
  };

  // Its own try, as in the Messages pass: a problem with group links must not
  // turn a successful 1:1 sync into a failure.
  let groups: WhatsAppGroupLinksSummary | { error: string };
  try {
    const threads = groupRows.map((r) => ({
      handles: (JSON.parse(r.jids) as string[])
        .map(resolve)
        .filter((h): h is string => !!h),
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
