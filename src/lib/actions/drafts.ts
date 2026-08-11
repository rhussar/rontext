"use server";

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  contactPhotos,
  contacts,
  drafts,
  type Draft,
  type DraftChannel,
} from "@/db/schema";

/**
 * Redeclared rather than imported: contacts.ts is a "use server" module, so
 * every one of its exports has to be an async server action — a sync helper
 * can't cross that boundary. Same reason revalidateAll is duplicated here.
 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function revalidateAll() {
  revalidatePath("/", "layout");
}

export async function createDraft(
  contactId: number,
  channel: DraftChannel,
  body: string,
  subject?: string,
): Promise<Draft> {
  const db = getDb();
  const [draft] = await db
    .insert(drafts)
    .values({
      contactId,
      channel,
      body: body.trim(),
      // A subject on a text or LinkedIn draft is meaningless — drop it at the
      // boundary so the column can be trusted everywhere downstream.
      subject: channel === "email" ? subject?.trim() || null : null,
    })
    .returning();
  revalidateAll();
  return draft;
}

export async function updateDraft(
  id: number,
  patch: { channel?: DraftChannel; subject?: string | null; body?: string },
): Promise<void> {
  const next: Partial<typeof drafts.$inferInsert> = { updatedAt: new Date() };
  if (patch.channel !== undefined) next.channel = patch.channel;
  if (patch.body !== undefined) next.body = patch.body.trim();
  if (patch.subject !== undefined) next.subject = patch.subject?.trim() || null;
  // Switching away from email retires the subject rather than orphaning it.
  if (next.channel && next.channel !== "email") next.subject = null;

  await getDb().update(drafts).set(next).where(eq(drafts.id, id));
  revalidateAll();
}

/**
 * Also bumps the contact's `lastInteractionDate`, on the same reasoning
 * `addNote` uses: messaging someone is an interaction, and without this they
 * keep surfacing in Home's "Haven't talked in a while" list right after you
 * wrote to them.
 */
export async function markDraftSent(id: number): Promise<void> {
  const db = getDb();
  const [row] = await db
    .update(drafts)
    .set({ sentAt: new Date(), updatedAt: new Date() })
    .where(eq(drafts.id, id))
    .returning({ contactId: drafts.contactId });
  if (row) {
    await db
      .update(contacts)
      .set({ lastInteractionDate: today(), updatedAt: new Date() })
      .where(eq(contacts.id, row.contactId));
  }
  revalidateAll();
}

/**
 * Deliberately does *not* roll `lastInteractionDate` back — the prior value
 * isn't recoverable, and every other date in this app is a high-water mark
 * (see rollupInteractions, which only ever widens). This is a mis-click
 * affordance, not an undo.
 */
export async function unmarkDraftSent(id: number): Promise<void> {
  await getDb()
    .update(drafts)
    .set({ sentAt: null, updatedAt: new Date() })
    .where(eq(drafts.id, id));
  revalidateAll();
}

export async function deleteDraft(id: number): Promise<void> {
  await getDb().delete(drafts).where(eq(drafts.id, id));
  revalidateAll();
}

export type OpenDraft = {
  id: number;
  contactId: number;
  contactName: string;
  company: string | null;
  title: string | null;
  hasPhoto: boolean;
  channel: DraftChannel;
  subject: string | null;
  body: string;
  /** ISO — a Date doesn't cross into a client component's props cleanly. */
  updatedAt: string;
};

export async function listOpenDrafts(): Promise<OpenDraft[]> {
  const rows = await getDb()
    .select({
      id: drafts.id,
      contactId: drafts.contactId,
      contactName: contacts.fullName,
      company: contacts.company,
      title: contacts.title,
      channel: drafts.channel,
      subject: drafts.subject,
      body: drafts.body,
      updatedAt: drafts.updatedAt,
      hasPhoto: sql<boolean>`${contactPhotos.contactId} is not null`,
    })
    .from(drafts)
    .innerJoin(contacts, eq(drafts.contactId, contacts.id))
    .leftJoin(contactPhotos, eq(contactPhotos.contactId, contacts.id))
    // Archiving someone shouldn't leave their draft nagging you from Home.
    .where(and(isNull(drafts.sentAt), isNull(contacts.archivedAt)))
    .orderBy(desc(drafts.updatedAt));

  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
}
