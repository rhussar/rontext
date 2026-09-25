/**
 * Text-thread reader for agents — Mac only. Rontext never summarizes on its
 * own: an agent (see .claude/skills/summarize-threads) uses this to read a
 * thread, writes the summary itself, and saves it with the MCP tool
 * `save_conversation_summary`.
 *
 *   set -a && source .env.local && set +a && npx tsx scripts/thread-summaries.ts <command>
 *
 *   --due [--max N]     JSON list of contacts whose thread has new messages
 *                       since their stored summary (newest first)
 *   --contact <id>      that contact's recent 1:1 thread, as a transcript,
 *                       after a JSON header line with the values to save back
 *   --clear             delete every stored summary (the undo)
 *
 * Unlike messages-reader.ts, this DOES read message text — it has to — which
 * is why it's a separate file: the counts reader's promise ("no text column
 * is ever selected") stays true of that file. Text goes to stdout, i.e. into
 * the agent session that asked for it, and nowhere else. Postgres only ever
 * receives the summary.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, threadSummaries } from "../src/db/schema";
import { contactIdsByHandleKey, handleKey } from "../src/lib/connector-ingest";
import { readChatDb, SECONDS_EXPR, windowStart } from "./messages-reader";

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

type ChatRow = { chatId: number; handle: string; n: number; lastSecs: number };
type MessageRow = { fromMe: number; secs: number; text: string | null; body: string | null };

function activeChats(sinceUnix: number): ChatRow[] {
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

/** Active 1:1 chats merged per contact (SMS and iMessage are separate chats). */
async function chatsByContact(): Promise<Map<number, { chatIds: number[]; n: number; lastSecs: number }>> {
  const byKey = await contactIdsByHandleKey();
  const out = new Map<number, { chatIds: number[]; n: number; lastSecs: number }>();
  for (const c of activeChats(windowStart(WINDOW_MONTHS))) {
    const key = handleKey(c.handle);
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
  messagesInWindow: number;
  lastMessageAt: string;
  /** The newest message the stored summary covers, or null if there is none. */
  summarizedThrough: string | null;
};

export async function dueThreads(max?: number): Promise<DueThread[]> {
  const chats = await chatsByContact();
  const ids = [...chats.keys()];
  if (!ids.length) return [];
  const db = getDb();
  const [existing, names] = await Promise.all([
    db
      .select({ contactId: threadSummaries.contactId, lastMessageAt: threadSummaries.lastMessageAt })
      .from(threadSummaries)
      .where(and(eq(threadSummaries.source, "imessage"), inArray(threadSummaries.contactId, ids))),
    db.select({ id: contacts.id, fullName: contacts.fullName }).from(contacts).where(inArray(contacts.id, ids)),
  ]);
  const builtFrom = new Map(existing.map((e) => [e.contactId, e.lastMessageAt]));
  const nameOf = new Map(names.map((n) => [n.id, n.fullName]));

  const due = [...chats.entries()]
    .filter(([id, c]) => c.n >= MIN_MESSAGES && c.lastSecs * 1000 > (builtFrom.get(id)?.getTime() ?? 0))
    .sort((a, b) => b[1].lastSecs - a[1].lastSecs)
    .map(([id, c]) => ({
      contactId: id,
      name: nameOf.get(id) ?? "(unknown)",
      messagesInWindow: c.n,
      lastMessageAt: new Date(c.lastSecs * 1000).toISOString(),
      summarizedThrough: builtFrom.get(id)?.toISOString() ?? null,
    }));
  return max !== undefined ? due.slice(0, max) : due;
}

function messageText(r: MessageRow): string | null {
  const raw = r.text?.trim() ? r.text : r.body ? decodeAttributedBody(r.body) : null;
  if (!raw) return null;
  const t = raw.replace(ATTACHMENT, "[attachment]").trim();
  if (!t) return null;
  return t.length > MAX_MESSAGE_CHARS ? `${t.slice(0, MAX_MESSAGE_CHARS)}…` : t;
}

/** Header (the values save_conversation_summary wants back) + transcript lines. */
export async function threadTranscript(contactId: number): Promise<string> {
  const chats = await chatsByContact();
  const c = chats.get(contactId);
  const [person] = await getDb()
    .select({ fullName: contacts.fullName })
    .from(contacts)
    .where(eq(contacts.id, contactId));
  if (!person) throw new Error(`No contact with id ${contactId}`);
  if (!c) throw new Error(`No 1:1 texts with ${person.fullName} in the last ${WINDOW_MONTHS} months`);

  const rows = readChatDb<MessageRow>(`
    SELECT fromMe, secs, text, body FROM (
      SELECT m.is_from_me AS fromMe, ${SECONDS_EXPR} AS secs,
        m.text AS text, hex(m.attributedBody) AS body, m.date AS d
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      WHERE cmj.chat_id IN (${c.chatIds.map((n) => Math.trunc(n)).join(",")})
        AND ${SECONDS_EXPR} >= ${windowStart(WINDOW_MONTHS)}
        AND m.associated_message_type = 0
        AND m.item_type = 0
      ORDER BY m.date DESC
      LIMIT ${MESSAGES_PER_CONTACT}
    ) ORDER BY d ASC
  `);
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

  if (argv.includes("--clear")) {
    const gone = await getDb().delete(threadSummaries).returning({ id: threadSummaries.contactId });
    console.log(`Deleted ${gone.length} thread summaries.`);
  } else if (argv.includes("--due")) {
    const max = arg("--max") ? Math.max(parseInt(arg("--max")!, 10) || 1, 1) : undefined;
    console.log(JSON.stringify(await dueThreads(max), null, 1));
  } else if (arg("--contact")) {
    console.log(await threadTranscript(parseInt(arg("--contact")!, 10)));
  } else {
    console.error("Usage: --due [--max N] | --contact <id> | --clear");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
