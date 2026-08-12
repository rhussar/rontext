"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contactCandidates, contacts } from "@/db/schema";
import {
  rollupInteractions,
  upsertInteractionPeriods,
  upsertInteractions,
} from "@/lib/interactions";

export type CandidateItem = {
  id: number;
  source: "gmail" | "messages";
  handle: string;
  displayName: string | null;
  messageCount: number;
  sentCount: number;
  receivedCount: number;
  firstAt: string | null;
  lastAt: string | null;
};

/**
 * The review queue: people a connector found who aren't in the CRM yet.
 *
 * Busiest first — the people you actually talk to are the ones worth deciding
 * about, and the tail is mostly one-off exchanges you'll never add.
 */
export async function listCandidates(): Promise<CandidateItem[]> {
  const rows = await getDb()
    .select()
    .from(contactCandidates)
    .where(eq(contactCandidates.status, "pending"))
    .orderBy(desc(contactCandidates.messageCount))
    .limit(300);

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    handle: r.handle,
    displayName: r.displayName,
    messageCount: r.messageCount,
    sentCount: r.sentCount,
    receivedCount: r.receivedCount,
    firstAt: r.firstAt,
    lastAt: r.lastAt,
  }));
}

/**
 * Turn a candidate into a real contact.
 *
 * This is the *only* path from a connector to a new contact — the ingests
 * themselves never insert into `contacts`. The handle carries over as an email
 * or phone so the next sync matches the contact directly and stops proposing
 * this person.
 */
export async function acceptCandidate(
  id: number,
  fullName: string,
): Promise<{ ok: boolean; contactId?: number; error?: string }> {
  const name = fullName.trim();
  if (!name) return { ok: false, error: "A name is required" };

  const db = getDb();
  const [candidate] = await db
    .select()
    .from(contactCandidates)
    .where(eq(contactCandidates.id, id));
  if (!candidate) return { ok: false, error: "Candidate not found" };
  if (candidate.status !== "pending") return { ok: false, error: "Already reviewed" };

  const isEmail = candidate.handle.includes("@");
  const spaceAt = name.indexOf(" ");

  const [row] = await db
    .insert(contacts)
    .values({
      fullName: name,
      firstName: spaceAt > 0 ? name.slice(0, spaceAt) : name,
      lastName: spaceAt > 0 ? name.slice(spaceAt + 1) : null,
      emails: isEmail ? [candidate.handle] : [],
      phoneNumbers: isEmail ? [] : [candidate.handle],
      source: candidate.source,
    })
    .returning({ id: contacts.id });

  const source = candidate.source === "gmail" ? "email" : "messages";
  await upsertInteractions([
    {
      contactId: row.id,
      source,
      firstAt: candidate.firstAt,
      lastAt: candidate.lastAt,
      messageCount: candidate.messageCount,
      sentCount: candidate.sentCount,
      receivedCount: candidate.receivedCount,
    },
  ]);
  // The monthly breakdown was parked on the candidate because interaction_periods
  // needs a contactId. Expanding it here is what gives a newly-accepted person a
  // populated timeline immediately instead of after the next sync.
  await upsertInteractionPeriods(
    candidate.periods.map((p) => ({ contactId: row.id, source, ...p })),
  );
  await rollupInteractions();

  await db
    .update(contactCandidates)
    .set({ status: "accepted", contactId: row.id, updatedAt: new Date() })
    .where(eq(contactCandidates.id, id));

  revalidatePath("/", "layout");
  return { ok: true, contactId: row.id };
}

/**
 * "Not a person." Dismissed rows are never revived — every connector's upsert
 * only touches rows still marked pending, so this decision holds across syncs.
 */
export async function dismissCandidate(id: number): Promise<void> {
  await getDb()
    .update(contactCandidates)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(eq(contactCandidates.id, id));
  revalidatePath("/", "layout");
}

/** Undo for the toast — puts a just-dismissed row back in the queue. */
export async function restoreCandidate(id: number): Promise<void> {
  await getDb()
    .update(contactCandidates)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(contactCandidates.id, id));
  revalidatePath("/", "layout");
}
