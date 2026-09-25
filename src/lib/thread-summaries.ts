/**
 * The write side of `thread_summaries`, shared by the MCP tool
 * `save_conversation_summary` and anything else that stores one.
 *
 * Rontext doesn't write these summaries itself: an agent reads the thread on
 * the Mac (scripts/thread-summaries.ts, guided by the summarize-threads
 * skill), writes the summary, and saves it through MCP. This module only
 * validates and stores what the agent sends.
 */

import { getDb } from "@/db";
import { contacts, threadSummaries, type ThreadDetails, type ThreadSource } from "@/db/schema";
import { eq } from "drizzle-orm";

/** The paragraph form stored in `summary` and indexed for find_people. */
export function renderSummary(d: ThreadDetails): string {
  return [
    d.overview,
    d.lastTopic ? `Most recently: ${d.lastTopic}` : null,
    d.openLoops.length ? `Open loops: ${d.openLoops.join("; ")}` : null,
    d.personalDetails.length ? `Their news: ${d.personalDetails.join("; ")}` : null,
    d.tone ? `Tone: ${d.tone}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export type SaveThreadSummaryInput = {
  contactId: number;
  /** Which thread this summarizes — one summary per contact per source. */
  source: ThreadSource;
  details: ThreadDetails;
  messagesCovered: number;
  firstMessageAt: Date | null;
  /** The newest message the summary covers — what decides when it's due again. */
  lastMessageAt: Date;
  /** Who wrote it, e.g. "claude-code" or a model id. Free text. */
  author: string;
};

export async function saveThreadSummary(
  input: SaveThreadSummaryInput,
): Promise<{ ok: true; contact: string } | { ok: false; error: string }> {
  const db = getDb();
  const [c] = await db
    .select({ fullName: contacts.fullName })
    .from(contacts)
    .where(eq(contacts.id, input.contactId));
  if (!c) return { ok: false, error: `No contact with id ${input.contactId}` };

  const clean = (s: string | null) => s?.trim() || null;
  const list = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  const details: ThreadDetails = {
    overview: input.details.overview.trim(),
    lastTopic: clean(input.details.lastTopic),
    openLoops: list(input.details.openLoops),
    personalDetails: list(input.details.personalDetails),
    tone: clean(input.details.tone),
  };

  const row = {
    contactId: input.contactId,
    source: input.source,
    summary: renderSummary(details),
    details,
    messagesCovered: input.messagesCovered,
    firstMessageAt: input.firstMessageAt,
    lastMessageAt: input.lastMessageAt,
    model: input.author,
    // Agent-written summaries follow the summarize-threads skill; bump that
    // skill's version line and this together if its output contract changes.
    promptVersion: 1,
    updatedAt: new Date(),
  };
  await db
    .insert(threadSummaries)
    .values(row)
    .onConflictDoUpdate({ target: [threadSummaries.contactId, threadSummaries.source], set: row });
  return { ok: true, contact: c.fullName };
}
