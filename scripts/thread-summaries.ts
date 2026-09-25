/**
 * Text-thread summaries: read recent 1:1 iMessage/SMS threads with contacts,
 * have Claude summarize each, store only the summary (thread_summaries).
 *
 *   set -a && source .env.local && set +a && npx tsx scripts/thread-summaries.ts
 *     --max 20        summarize at most 20 threads this run (default: all due)
 *     --dry-run       show which threads are due; read and send nothing
 *     --clear         delete every stored summary (the undo)
 *
 * Also run nightly by scripts/mac-agent.ts with a cap.
 *
 * Unlike messages-reader.ts, this DOES read message text — it has to — and
 * that is the whole reason it's a separate file: the counts reader's promise
 * ("no text column is ever selected") stays true of that file. The text
 * lives only in this process's memory and in the request to Anthropic; what
 * reaches Postgres is the summary.
 *
 * A thread is due when it has at least MIN_MESSAGES in the window and a
 * message newer than the one its stored summary was built from.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, threadSummaries } from "../src/db/schema";
import { getSecret } from "../src/lib/secrets";
import { contactIdsByHandleKey, handleKey } from "../src/lib/connector-ingest";
import {
  PROMPT_VERSION,
  renderSummary,
  summarizeThread,
  type ThreadMessage,
} from "../src/lib/thread-summary-ai";
import { readChatDb, SECONDS_EXPR, windowStart } from "./messages-reader";

const WINDOW_MONTHS = 12;
/** Fewer than this in a year is logistics, not a relationship worth summarizing. */
const MIN_MESSAGES = 6;
/** The most recent N messages per contact are what the summary is written from. */
const MESSAGES_PER_CONTACT = 150;
const CONCURRENCY = 4;

/** U+FFFC is Apple's placeholder for an inline attachment. */
const ATTACHMENT = /￼/g;

/**
 * Pull the plain string out of message.attributedBody — an NSAttributedString
 * in Apple's "typedstream" archive format, which is where macOS has kept
 * message text since Ventura (`text` is usually null now).
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
type MessageRow = { chatId: number; fromMe: number; secs: number; text: string | null; body: string | null };

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

function recentMessages(chatIds: number[], sinceUnix: number): MessageRow[] {
  if (!chatIds.length) return [];
  return readChatDb<MessageRow>(`
    SELECT chatId, fromMe, secs, text, body FROM (
      SELECT cmj.chat_id AS chatId, m.is_from_me AS fromMe, ${SECONDS_EXPR} AS secs,
        m.text AS text, hex(m.attributedBody) AS body,
        ROW_NUMBER() OVER (PARTITION BY cmj.chat_id ORDER BY m.date DESC) AS rn
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      WHERE cmj.chat_id IN (${chatIds.map((n) => Math.trunc(n)).join(",")})
        AND ${SECONDS_EXPR} >= ${sinceUnix}
        AND m.associated_message_type = 0
        AND m.item_type = 0
    )
    WHERE rn <= ${MESSAGES_PER_CONTACT}
  `);
}

function messageText(r: MessageRow): string | null {
  const raw = r.text?.trim() ? r.text : r.body ? decodeAttributedBody(r.body) : null;
  if (!raw) return null;
  const t = raw.replace(ATTACHMENT, "[attachment]").trim();
  return t || null;
}

export type ThreadSummarySync = {
  due: number;
  summarized: number;
  failed: number;
  skippedCap: number;
  errors: string[];
};

export async function syncThreadSummaries(opts: {
  max?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}): Promise<ThreadSummarySync> {
  const log = opts.log ?? (() => {});
  const since = windowStart(WINDOW_MONTHS);
  const db = getDb();

  // 1. Which contacts have an active 1:1 thread, merged across their handles
  //    (SMS and iMessage are separate chats for the same person).
  const byKey = await contactIdsByHandleKey();
  const perContact = new Map<number, { chatIds: number[]; n: number; lastSecs: number }>();
  for (const c of activeChats(since)) {
    const key = handleKey(c.handle);
    const id = key ? byKey.get(key) : undefined;
    if (id === undefined) continue;
    const acc = perContact.get(id) ?? { chatIds: [], n: 0, lastSecs: 0 };
    acc.chatIds.push(c.chatId);
    acc.n += c.n;
    acc.lastSecs = Math.max(acc.lastSecs, c.lastSecs);
    perContact.set(id, acc);
  }

  // 2. Due = enough messages and newer than the stored summary.
  const ids = [...perContact.keys()];
  const existing = ids.length
    ? await db
        .select({ contactId: threadSummaries.contactId, lastMessageAt: threadSummaries.lastMessageAt })
        .from(threadSummaries)
        .where(and(eq(threadSummaries.source, "imessage"), inArray(threadSummaries.contactId, ids)))
    : [];
  const builtFrom = new Map(existing.map((e) => [e.contactId, e.lastMessageAt.getTime()]));
  const due = [...perContact.entries()]
    .filter(([id, c]) => c.n >= MIN_MESSAGES && c.lastSecs * 1000 > (builtFrom.get(id) ?? 0))
    .sort((a, b) => b[1].lastSecs - a[1].lastSecs);
  const batch = opts.max !== undefined ? due.slice(0, opts.max) : due;
  log(
    `Threads: ${perContact.size} contacts texted in the last ${WINDOW_MONTHS} months, ` +
      `${due.length} due for a summary${batch.length < due.length ? `, doing ${batch.length} this run` : ""}.`,
  );
  const summary: ThreadSummarySync = {
    due: due.length,
    summarized: 0,
    failed: 0,
    skippedCap: due.length - batch.length,
    errors: [],
  };
  if (opts.dryRun || batch.length === 0) return summary;

  const apiKey = await getSecret("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set — add it in Settings → Connections");
  const client = new Anthropic({ apiKey });

  const names = new Map(
    (
      await db
        .select({ id: contacts.id, fullName: contacts.fullName })
        .from(contacts)
        .where(inArray(contacts.id, batch.map(([id]) => id)))
    ).map((r) => [r.id, r.fullName]),
  );

  // 3. Text for just the due chats, grouped back to contacts.
  const chatToContact = new Map<number, number>();
  for (const [id, c] of batch) for (const chat of c.chatIds) chatToContact.set(chat, id);
  const threads = new Map<number, ThreadMessage[]>();
  for (const r of recentMessages([...chatToContact.keys()], since)) {
    const text = messageText(r);
    if (!text) continue;
    const id = chatToContact.get(r.chatId)!;
    const list = threads.get(id) ?? [];
    list.push({ at: r.secs * 1000, fromMe: r.fromMe === 1, text });
    threads.set(id, list);
  }

  // 4. Summarize with a small worker pool; write each as it lands, so an
  //    interrupted run keeps what it finished.
  const queue = batch.map(([id]) => id);
  let stopAll: string | null = null;
  async function worker() {
    while (queue.length && !stopAll) {
      const id = queue.shift()!;
      const msgs = (threads.get(id) ?? []).sort((a, b) => a.at - b.at).slice(-MESSAGES_PER_CONTACT);
      if (msgs.length < MIN_MESSAGES) continue;
      const name = names.get(id) ?? "this contact";
      const res = await summarizeThread(client, name, msgs);
      if (!res.ok) {
        summary.failed++;
        summary.errors.push(`${name}: ${res.error}`);
        if (res.error.includes("API key")) stopAll = res.error;
        continue;
      }
      const row = {
        contactId: id,
        source: "imessage" as const,
        summary: renderSummary(res.details),
        details: res.details,
        messagesCovered: msgs.length,
        firstMessageAt: new Date(msgs[0].at),
        lastMessageAt: new Date(msgs[msgs.length - 1].at),
        model: res.model,
        promptVersion: PROMPT_VERSION,
        updatedAt: new Date(),
      };
      await db
        .insert(threadSummaries)
        .values(row)
        .onConflictDoUpdate({ target: [threadSummaries.contactId, threadSummaries.source], set: row });
      summary.summarized++;
      log(`  ✓ ${name} (${msgs.length} messages)`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (stopAll) throw new Error(stopAll);
  return summary;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--clear")) {
    const gone = await getDb().delete(threadSummaries).returning({ id: threadSummaries.contactId });
    console.log(`Deleted ${gone.length} thread summaries.`);
    return;
  }
  const maxArg = argv.indexOf("--max");
  const max = maxArg >= 0 ? Math.max(parseInt(argv[maxArg + 1] ?? "0", 10) || 0, 1) : undefined;
  const s = await syncThreadSummaries({ max, dryRun: argv.includes("--dry-run"), log: console.log });
  console.log(JSON.stringify(s, null, 2));
}

// Run only as a script, not when mac-agent.ts imports syncThreadSummaries.
if (process.argv[1]?.endsWith("thread-summaries.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
