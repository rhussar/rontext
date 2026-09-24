import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, meetingContacts, meetings, type Meeting } from "@/db/schema";

/**
 * Meeting ingest and assignment — shared by the MCP `add_meeting` tool and the
 * server actions behind the timeline and the Data → Meetings queue.
 */

export type MeetingInput = {
  externalId: string;
  title: string;
  startedAt: Date;
  endedAt?: Date | null;
  summary?: string | null;
  notes?: string | null;
  transcript?: string | null;
  shareLink?: string | null;
  /** Names or emails as the source listed them; kept as the "who was it?" hint. */
  attendees?: string[];
  /** Matched against contacts.emails, case-insensitively. */
  attendeeEmails?: string[];
  /** Explicit people, when the caller already knows who it was. */
  contactIds?: number[];
};

export type IngestResult = {
  meetingId: number;
  created: boolean;
  contactIds: number[];
  /** True when nobody could be matched — it's waiting in Data → Meetings. */
  needsReview: boolean;
};

/**
 * Upsert by (source, externalId). Re-pushing a meeting refreshes its content
 * and ADDS any newly matched people, but never removes an assignment — one made
 * by hand in the Data queue must survive the next sync of the same meeting.
 */
export async function ingestMeeting(input: MeetingInput): Promise<IngestResult> {
  const db = getDb();
  const now = new Date();
  const values = {
    source: "wispr" as const,
    externalId: input.externalId,
    title: input.title.trim() || "Untitled meeting",
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
    summary: input.summary?.trim() || null,
    notes: input.notes?.trim() || null,
    transcript: input.transcript?.trim() || null,
    shareLink: input.shareLink ?? null,
    attendees: input.attendees ?? [],
    updatedAt: now,
  };
  const [row] = await db
    .insert(meetings)
    .values(values)
    .onConflictDoUpdate({
      target: [meetings.source, meetings.externalId],
      set: values,
    })
    // xmax = 0 only on a freshly inserted row — Postgres' tell for "not an update".
    .returning({ id: meetings.id, inserted: sql<boolean>`(xmax = 0)` });

  const ids = new Set<number>();
  if (input.contactIds?.length) {
    // Only ids that exist — a stale or invented one would fail the FK insert.
    const live = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.id, input.contactIds));
    live.forEach((c) => ids.add(c.id));
  }
  const emails = (input.attendeeEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (emails.length) {
    const hits = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        sql`${contacts.archivedAt} is null and exists (
          select 1 from unnest(${contacts.emails}) e
          where lower(e) in (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})
        )`,
      );
    hits.forEach((h) => ids.add(h.id));
  }
  if (ids.size) await linkContacts(row.id, [...ids], input.startedAt);

  const linked = await db
    .select({ contactId: meetingContacts.contactId })
    .from(meetingContacts)
    .where(eq(meetingContacts.meetingId, row.id));
  return {
    meetingId: row.id,
    created: row.inserted,
    contactIds: linked.map((l) => l.contactId),
    needsReview: linked.length === 0,
  };
}

/**
 * Attach people to a meeting and move their last-interaction date forward to
 * it — never back, so assigning an old meeting can't make someone look colder.
 */
export async function linkContacts(meetingId: number, contactIds: number[], startedAt: Date) {
  if (!contactIds.length) return;
  const db = getDb();
  await db
    .insert(meetingContacts)
    .values(contactIds.map((contactId) => ({ meetingId, contactId })))
    .onConflictDoNothing();
  const day = startedAt.toISOString().slice(0, 10);
  await db
    .update(contacts)
    .set({
      lastInteractionDate: sql`greatest(${contacts.lastInteractionDate}, ${day}::date)`,
      updatedAt: new Date(),
    })
    .where(inArray(contacts.id, contactIds));
}

export async function unlinkContact(meetingId: number, contactId: number) {
  await getDb()
    .delete(meetingContacts)
    .where(and(eq(meetingContacts.meetingId, meetingId), eq(meetingContacts.contactId, contactId)));
}

/**
 * The meeting as one markdown document — what "Download .md" serves. Sections
 * that the notetaker didn't produce are left out rather than printed empty.
 */
export function meetingMarkdown(m: Meeting, people: string[], timeZone?: string): string {
  // The server runs in UTC; the caller passes the viewer's zone so "When" reads
  // as the time the meeting actually was for them.
  let when: string;
  try {
    when = new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone,
    }).format(m.startedAt);
  } catch {
    when = m.startedAt.toISOString();
  }
  const mins = m.endedAt
    ? Math.round((m.endedAt.getTime() - m.startedAt.getTime()) / 60_000)
    : null;
  const lines = [`# ${m.title}`, ""];
  lines.push(`- **When:** ${when}${mins ? ` (${mins} min)` : ""}`);
  if (people.length) lines.push(`- **With:** ${people.join(", ")}`);
  if (m.shareLink) lines.push(`- **Wispr Flow:** ${m.shareLink}`);
  lines.push("");
  if (m.summary) lines.push("## Summary", "", m.summary, "");
  if (m.notes) lines.push("## Notes", "", m.notes, "");
  if (m.transcript) lines.push("## Transcript", "", m.transcript, "");
  return lines.join("\n");
}

/** "2026-09-20 AI Marketing Agent Development.md" — sortable, filesystem-safe. */
export function meetingFilename(m: Pick<Meeting, "title" | "startedAt">): string {
  const safe = m.title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${m.startedAt.toISOString().slice(0, 10)} ${safe || "Meeting"}.md`;
}
