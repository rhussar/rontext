"use server";

import { and, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contacts, meetingContacts, meetings, type Meeting } from "@/db/schema";
import { linkContacts, unlinkContact } from "@/lib/meetings";

/** What the timeline row needs — no bodies, so a profile click stays light. */
export type MeetingMeta = {
  id: number;
  title: string;
  startedAt: Date;
  endedAt: Date | null;
};

export type MeetingFull = Meeting & {
  people: { id: number; fullName: string }[];
};

export type UnresolvedMeeting = {
  id: number;
  title: string;
  startedAt: Date;
  endedAt: Date | null;
  attendees: string[];
  /** First paragraph-ish of the summary — enough to jog "oh, that was Priya". */
  excerpt: string | null;
};

export async function getMeeting(id: number): Promise<MeetingFull | null> {
  const db = getDb();
  const [m] = await db.select().from(meetings).where(eq(meetings.id, id));
  if (!m) return null;
  const people = await db
    .select({ id: contacts.id, fullName: contacts.fullName })
    .from(meetingContacts)
    .innerJoin(contacts, eq(contacts.id, meetingContacts.contactId))
    .where(eq(meetingContacts.meetingId, id));
  return { ...m, people };
}

/** Meetings nobody's been matched to, newest first — the Data → Meetings queue. */
export async function listUnresolvedMeetings(): Promise<UnresolvedMeeting[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: meetings.id,
      title: meetings.title,
      startedAt: meetings.startedAt,
      endedAt: meetings.endedAt,
      attendees: meetings.attendees,
      excerpt: sql<string | null>`left(${meetings.summary}, 400)`,
    })
    .from(meetings)
    .where(
      and(
        isNull(meetings.dismissedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(meetingContacts)
            .where(eq(meetingContacts.meetingId, meetings.id)),
        ),
      ),
    )
    .orderBy(desc(meetings.startedAt));
  return rows;
}

export async function assignMeeting(meetingId: number, contactIds: number[]) {
  const db = getDb();
  const [m] = await db
    .select({ startedAt: meetings.startedAt })
    .from(meetings)
    .where(eq(meetings.id, meetingId));
  if (!m) return;
  const live = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(inArray(contacts.id, contactIds));
  await linkContacts(meetingId, live.map((c) => c.id), m.startedAt);
  revalidatePath("/", "layout");
}

export async function unassignMeeting(meetingId: number, contactId: number) {
  await unlinkContact(meetingId, contactId);
  revalidatePath("/", "layout");
}

export async function setMeetingDismissed(meetingId: number, dismissed: boolean) {
  await getDb()
    .update(meetings)
    .set({ dismissedAt: dismissed ? new Date() : null, updatedAt: new Date() })
    .where(eq(meetings.id, meetingId));
  revalidatePath("/", "layout");
}
