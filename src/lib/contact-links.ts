/**
 * Writes `contact_links` — observed "these two know each other" pairs.
 *
 * Readers hand over threads as lists of raw handles (phone numbers, emails);
 * this module resolves them to contacts with the same keying the connectors
 * use, expands each thread into pairs, and replaces the source's rows.
 *
 * Only pairs where BOTH people are in the book are kept. A thread member who
 * isn't a contact is simply dropped — this is never a way for someone to
 * enter the CRM (that's the candidates queue's job, and group chats are
 * exactly the junk it filters out).
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contactLinks, type ContactLinkSource } from "@/db/schema";
import { contactIdsByHandleKey, handleKey } from "@/lib/connector-ingest";

export type LinkThread = {
  /** Everyone in the thread except the owner, as the source spells them. */
  handles: string[];
  /** Messages in the thread within the sync window. */
  messages: number;
  /** "YYYY-MM-DD" of the latest message. */
  lastAt: string;
};

export type LinkSummary = {
  threads: number;
  /** Threads with at least two members who are contacts. */
  usableThreads: number;
  pairs: number;
  people: number;
};

const INSERT_BATCH = 500;

export async function replaceLinks(
  source: ContactLinkSource,
  threads: LinkThread[],
  opts: { dryRun?: boolean } = {},
): Promise<LinkSummary> {
  const byKey = await contactIdsByHandleKey();

  type Pair = { threads: number; messages: number; lastAt: string };
  const pairs = new Map<string, Pair>();
  let usable = 0;

  for (const t of threads) {
    // Dedupe per thread: SMS and iMessage handles for one person resolve to
    // the same contact, and must not pair that person with themselves.
    const ids = [
      ...new Set(
        t.handles
          .map((h) => handleKey(h))
          .map((k) => (k ? byKey.get(k) : undefined))
          .filter((id): id is number => id !== undefined),
      ),
    ].sort((a, b) => a - b);
    if (ids.length < 2) continue;
    usable++;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = `${ids[i]}:${ids[j]}`;
        const p = pairs.get(k) ?? { threads: 0, messages: 0, lastAt: t.lastAt };
        p.threads++;
        p.messages += t.messages;
        if (t.lastAt > p.lastAt) p.lastAt = t.lastAt;
        pairs.set(k, p);
      }
    }
  }

  const rows = [...pairs.entries()].map(([k, p]) => {
    const [a, b] = k.split(":").map(Number);
    return { contactA: a, contactB: b, source, ...p, updatedAt: new Date() };
  });
  const people = new Set(rows.flatMap((r) => [r.contactA, r.contactB])).size;
  const summary = { threads: threads.length, usableThreads: usable, pairs: rows.length, people };
  if (opts.dryRun) return summary;

  // One transaction: a reader of contact_links never sees the source empty.
  const db = getDb();
  const inserts = [];
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    inserts.push(db.insert(contactLinks).values(rows.slice(i, i + INSERT_BATCH)));
  }
  await db.batch([db.delete(contactLinks).where(eq(contactLinks.source, source)), ...inserts]);
  return summary;
}
