/**
 * Text-thread reader for agents — Mac only. Rontext never summarizes on its
 * own: an agent (see .claude/skills/summarize-threads) uses this to read a
 * thread, writes the summary itself, and saves it with the MCP tool
 * `save_conversation_summary`.
 *
 *   set -a && source .env.local && set +a && npx tsx scripts/thread-summaries.ts <command>
 *
 *   --due [--max N] [--source imessage|whatsapp]
 *                       JSON list of threads with new messages since their
 *                       stored summary (newest first), both sources by default
 *   --contact <id> [--source imessage|whatsapp]
 *                       that contact's recent 1:1 thread on one source
 *                       (default imessage), as a transcript after a JSON
 *                       header line with the values to save back
 *   --clear             delete every stored summary (the undo)
 *
 * iMessage and WhatsApp are separate threads with separate summaries: the
 * same person often uses each for different things, and a WhatsApp group of
 * friends abroad is not the same conversation as their iMessages.
 *
 * Unlike messages-reader.ts and whatsapp-reader.ts, this DOES read message
 * text — it has to — which is why it's a separate file: the counts readers'
 * promise ("no text column is ever selected") stays true of those files. Text goes to stdout, i.e. into
 * the agent session that asked for it, and nowhere else. Postgres only ever
 * receives the summary.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, THREAD_SOURCES, threadSummaries, type ThreadSource } from "../src/db/schema";
import { contactIdsByHandleKey, handleKey } from "../src/lib/connector-ingest";
import { readChatDb, readSqliteCopy, SECONDS_EXPR, windowStart } from "./messages-reader";
import {
  LID_JID,
  loadJidResolver,
  PERSON_JID,
  SYSTEM_MESSAGE_TYPE,
  WA_SECONDS_EXPR,
  WHATSAPP_DB,
  whatsappInstalled,
} from "./whatsapp-reader";

const WINDOW_MONTHS = 12;
/** Fewer than this in a year is logistics, not a relationship worth summarizing. */
const MIN_MESSAGES = 6;
/** The most recent N messages are what a summary is written from. */
const MESSAGES_PER_CONTACT = 150;
/** Per-message cap in the transcript — a pasted article isn't conversation. */
const MAX_MESSAGE_CHARS = 600;

/** U+FFFC is Apple's placeholder for an inline attachment. */
const ATTACHMENT = /￼/g;

/**
 * Pull the plain string out of message.attributedBody — an NSAttributedString
 * in Apple's "typedstream" archive format, which is where macOS has kept
 * message text since Ventura (`text` is null on ~98% of recent rows).
 *
 * The string follows the "NSString" class name as: a '+' type tag, a length
 * (one byte; or 0x81 + uint16 LE; or 0x82 + uint32 LE), then UTF-8 bytes.
 * Returns null if the layout isn't what's expected — a skipped message is
 * better than a garbled one.
 */
export function decodeAttributedBody(hex: string): string | null {
  const buf = Buffer.from(hex, "hex");
  const marker = buf.indexOf("NSString");
  if (marker < 0) return null;
  const plus = buf.indexOf(0x2b, marker + 8);
  if (plus < 0 || plus - marker > 20) return null;
  let i = plus + 1;
  let len = buf[i];
  if (len === 0x81) {
    len = buf.readUInt16LE(i + 1);
    i += 3;
  } else if (len === 0x82) {
    len = buf.readUInt32LE(i + 1);
    i += 5;
  } else {
    i += 1;
  }
  if (i + len > buf.length) return null;
  return buf.subarray(i, i + len).toString("utf8");
}

const ONE_ON_ONE = `
  one_on_one AS (
    SELECT chat_id, MIN(handle_id) AS handle_id
    FROM chat_handle_join
    GROUP BY chat_id
    HAVING COUNT(*) = 1
  )`;

type ChatRow = { chatId: number; handle: string | null; n: number; lastSecs: number };
type MessageRow = {
  fromMe: number;
  secs: number;
  text: string | null;
  body: string | null;
  /** WhatsApp's ZMESSAGETYPE; null for iMessage. */
  type: number | null;
};
type ContactChats = { chatIds: number[]; n: number; lastSecs: number };

/** Active 1:1 chats per source, each with the handle it's addressed to. */
function activeChats(source: ThreadSource, sinceUnix: number): ChatRow[] {
  if (source === "imessage") {
    return readChatDb<ChatRow>(`
      WITH ${ONE_ON_ONE}
      SELECT o.chat_id AS chatId, h.id AS handle, COUNT(*) AS n, MAX(${SECONDS_EXPR}) AS lastSecs
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN one_on_one o          ON o.chat_id = cmj.chat_id
      JOIN handle h              ON h.ROWID = o.handle_id
      WHERE ${SECONDS_EXPR} >= ${sinceUnix}
        AND m.associated_message_type = 0
        AND m.item_type = 0
      GROUP BY o.chat_id
    `);
  }
  if (!whatsappInstalled()) return [];
  // Hidden-number (LID) chats resolve to a phone the same way the counts sync
  // does; one that can't be resolved can't be tied to a contact and drops out.
  const { resolve } = loadJidResolver();
  return readSqliteCopy<Omit<ChatRow, "handle"> & { jid: string }>(
    WHATSAPP_DB,
    `
      SELECT s.Z_PK AS chatId, s.ZCONTACTJID AS jid, COUNT(*) AS n, MAX(${WA_SECONDS_EXPR}) AS lastSecs
      FROM ZWAMESSAGE m
      JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
      WHERE (s.ZCONTACTJID LIKE '%${PERSON_JID}' OR s.ZCONTACTJID LIKE '%${LID_JID}')
        AND m.ZMESSAGEDATE IS NOT NULL
        AND ${WA_SECONDS_EXPR} >= ${sinceUnix}
        AND COALESCE(m.ZMESSAGETYPE, 0) <> ${SYSTEM_MESSAGE_TYPE}
      GROUP BY s.Z_PK
    `,
  ).map(({ jid, ...r }) => ({ ...r, handle: resolve(jid) }));
}

/**
 * Active 1:1 chats merged per contact — SMS and iMessage are separate chats,
 * and so are a WhatsApp number chat and its newer hidden-number twin.
 */
async function chatsByContact(source: ThreadSource): Promise<Map<number, ContactChats>> {
  const byKey = await contactIdsByHandleKey();
  const out = new Map<number, ContactChats>();
  for (const c of activeChats(source, windowStart(WINDOW_MONTHS))) {
    const key = c.handle ? handleKey(c.handle) : null;
    const id = key ? byKey.get(key) : undefined;
    if (id === undefined) continue;
    const acc = out.get(id) ?? { chatIds: [], n: 0, lastSecs: 0 };
    acc.chatIds.push(c.chatId);
    acc.n += c.n;
    acc.lastSecs = Math.max(acc.lastSecs, c.lastSecs);
    out.set(id, acc);
  }
  return out;
}

export type DueThread = {
  contactId: number;
  name: string;
  /** Pass back as --source, and to save_conversation_summary. */
  source: ThreadSource;
  messagesInWindow: number;
  lastMessageAt: string;
  /** The newest message the stored summary covers, or null if there is none. */
  summarizedThrough: string | null;
};

async function dueFor(source: ThreadSource): Promise<DueThread[]> {
  const chats = await chatsByContact(source);
  const ids = [...chats.keys()];
  if (!ids.length) return [];
  const db = getDb();
  const [existing, names] = await Promise.all([
    db
      .select({ contactId: threadSummaries.contactId, lastMessageAt: threadSummaries.lastMessageAt })
      .from(threadSummaries)
      .where(and(eq(threadSummaries.source, source), inArray(threadSummaries.contactId, ids))),
    db.select({ id: contacts.id, fullName: contacts.fullName }).from(contacts).where(inArray(contacts.id, ids)),
  ]);
  const builtFrom = new Map(existing.map((e) => [e.contactId, e.lastMessageAt]));
  const nameOf = new Map(names.map((n) => [n.id, n.fullName]));

  return [...chats.entries()]
    .filter(([id, c]) => c.n >= MIN_MESSAGES && c.lastSecs * 1000 > (builtFrom.get(id)?.getTime() ?? 0))
    .map(([id, c]) => ({
      contactId: id,
      name: nameOf.get(id) ?? "(unknown)",
      source,
      messagesInWindow: c.n,
      lastMessageAt: new Date(c.lastSecs * 1000).toISOString(),
      summarizedThrough: builtFrom.get(id)?.toISOString() ?? null,
    }));
}

export async function dueThreads(max?: number, only?: ThreadSource): Promise<DueThread[]> {
  const sources = only ? [only] : [...THREAD_SOURCES];
  const due = (await Promise.all(sources.map(dueFor)))
    .flat()
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  return max !== undefined ? due.slice(0, max) : due;
}

/**
 * WhatsApp media rows carry their caption in ZTEXT, or nothing. A bare photo
 * still belongs in the transcript — "sent a photo" is part of the rhythm —
 * so it becomes a placeholder rather than vanishing.
 */
const WA_MEDIA: Record<number, string> = {
  1: "[photo]",
  2: "[video]",
  3: "[voice note]",
  4: "[contact card]",
  5: "[location]",
  8: "[document]",
  11: "[GIF]",
  15: "[sticker]",
};

function messageText(r: MessageRow): string | null {
  const raw = r.text?.trim()
    ? r.text
    : r.body
      ? decodeAttributedBody(r.body)
      : r.type !== null
        ? (WA_MEDIA[r.type] ?? null)
        : null;
  if (!raw) return null;
  const t = raw.replace(ATTACHMENT, "[attachment]").trim();
  if (!t) return null;
  return t.length > MAX_MESSAGE_CHARS ? `${t.slice(0, MAX_MESSAGE_CHARS)}…` : t;
}

function readMessages(source: ThreadSource, chatIds: number[]): MessageRow[] {
  const ids = chatIds.map((n) => Math.trunc(n)).join(",");
  const since = windowStart(WINDOW_MONTHS);
  if (source === "imessage") {
    return readChatDb<MessageRow>(`
      SELECT fromMe, secs, text, body, NULL AS type FROM (
        SELECT m.is_from_me AS fromMe, ${SECONDS_EXPR} AS secs,
          m.text AS text, hex(m.attributedBody) AS body, m.date AS d
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE cmj.chat_id IN (${ids})
          AND ${SECONDS_EXPR} >= ${since}
          AND m.associated_message_type = 0
          AND m.item_type = 0
        ORDER BY m.date DESC
        LIMIT ${MESSAGES_PER_CONTACT}
      ) ORDER BY d ASC
    `);
  }
  return readSqliteCopy<MessageRow>(
    WHATSAPP_DB,
    `
      SELECT fromMe, secs, text, NULL AS body, type FROM (
        SELECT m.ZISFROMME AS fromMe, ${WA_SECONDS_EXPR} AS secs,
          m.ZTEXT AS text, COALESCE(m.ZMESSAGETYPE, 0) AS type, m.ZMESSAGEDATE AS d
        FROM ZWAMESSAGE m
        WHERE m.ZCHATSESSION IN (${ids})
          AND m.ZMESSAGEDATE IS NOT NULL
          AND ${WA_SECONDS_EXPR} >= ${since}
          AND COALESCE(m.ZMESSAGETYPE, 0) <> ${SYSTEM_MESSAGE_TYPE}
        ORDER BY m.ZMESSAGEDATE DESC
        LIMIT ${MESSAGES_PER_CONTACT}
      ) ORDER BY d ASC
    `,
  );
}

/** Header (the values save_conversation_summary wants back) + transcript lines. */
export async function threadTranscript(contactId: number, source: ThreadSource = "imessage"): Promise<string> {
  const chats = await chatsByContact(source);
  const c = chats.get(contactId);
  const [person] = await getDb()
    .select({ fullName: contacts.fullName })
    .from(contacts)
    .where(eq(contacts.id, contactId));
  if (!person) throw new Error(`No contact with id ${contactId}`);
  const what = source === "whatsapp" ? "WhatsApp chats" : "texts";
  if (!c) throw new Error(`No 1:1 ${what} with ${person.fullName} in the last ${WINDOW_MONTHS} months`);

  const rows = readMessages(source, c.chatIds);
  const first = person.fullName.split(/\s+/)[0] || person.fullName;
  const lines: string[] = [];
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  for (const r of rows) {
    const text = messageText(r);
    if (!text) continue;
    const at = r.secs * 1000;
    firstAt ??= at;
    lastAt = at;
    lines.push(`[${new Date(at).toISOString().slice(0, 10)}] ${r.fromMe ? "You" : first}: ${text}`);
  }
  const header = {
    contact_id: contactId,
    name: person.fullName,
    source,
    messages_covered: lines.length,
    first_message_at: firstAt ? new Date(firstAt).toISOString() : null,
    last_message_at: lastAt ? new Date(lastAt).toISOString() : null,
  };
  return `${JSON.stringify(header)}\n<thread>\n${lines.join("\n")}\n</thread>`;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const sourceArg = arg("--source");
  if (sourceArg && !(THREAD_SOURCES as readonly string[]).includes(sourceArg)) {
    console.error(`--source takes ${THREAD_SOURCES.join(" or ")}, got ${JSON.stringify(sourceArg)}`);
    process.exit(2);
  }
  const source = sourceArg as ThreadSource | undefined;

  if (argv.includes("--clear")) {
    const gone = await getDb().delete(threadSummaries).returning({ id: threadSummaries.contactId });
    console.log(`Deleted ${gone.length} thread summaries.`);
  } else if (argv.includes("--due")) {
    const max = arg("--max") ? Math.max(parseInt(arg("--max")!, 10) || 1, 1) : undefined;
    console.log(JSON.stringify(await dueThreads(max, source), null, 1));
  } else if (arg("--contact")) {
    console.log(await threadTranscript(parseInt(arg("--contact")!, 10), source ?? "imessage"));
  } else {
    console.error("Usage: --due [--max N] [--source S] | --contact <id> [--source S] | --clear");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
