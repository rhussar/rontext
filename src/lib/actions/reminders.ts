"use server";

import { asc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contactPhotos, contacts, reminders, type Reminder } from "@/db/schema";

function revalidateAll() {
  revalidatePath("/", "layout");
}

/** `remindAt` arrives as an ISO instant — the client resolves the user's timezone. */
export async function createReminder(
  contactId: number,
  remindAt: string,
  body?: string,
): Promise<Reminder> {
  const db = getDb();
  const [reminder] = await db
    .insert(reminders)
    .values({ contactId, remindAt: new Date(remindAt), body: body?.trim() || null })
    .returning();
  revalidateAll();
  return reminder;
}

export async function completeReminder(id: number) {
  await getDb()
    .update(reminders)
    .set({ completedAt: new Date() })
    .where(eq(reminders.id, id));
  revalidateAll();
}

export async function uncompleteReminder(id: number) {
  await getDb()
    .update(reminders)
    .set({ completedAt: null })
    .where(eq(reminders.id, id));
  revalidateAll();
}

export async function deleteReminder(id: number) {
  await getDb().delete(reminders).where(eq(reminders.id, id));
  revalidateAll();
}

export type UpcomingReminder = {
  id: number;
  contactId: number;
  contactName: string;
  company: string | null;
  title: string | null;
  hasPhoto: boolean;
  remindAt: string;
  body: string | null;
  /**
   * Computed here rather than in the client component: comparing against the
   * clock during render would differ between server and browser and trip a
   * hydration mismatch for any reminder due right around page load.
   */
  overdue: boolean;
};

export async function listUpcomingReminders(): Promise<UpcomingReminder[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: reminders.id,
      contactId: reminders.contactId,
      contactName: contacts.fullName,
      company: contacts.company,
      title: contacts.title,
      remindAt: reminders.remindAt,
      body: reminders.body,
      hasPhoto: sql<boolean>`${contactPhotos.contactId} is not null`,
    })
    .from(reminders)
    .innerJoin(contacts, eq(reminders.contactId, contacts.id))
    .leftJoin(contactPhotos, eq(contactPhotos.contactId, contacts.id))
    .where(isNull(reminders.completedAt))
    .orderBy(asc(reminders.remindAt)); // overdue sort to the top naturally

  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    remindAt: r.remindAt.toISOString(),
    overdue: r.remindAt.getTime() < now,
  }));
}
