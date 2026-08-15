"use server";

import { and, asc, desc, eq, gte } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  contactChanges,
  contactDocs,
  contactEducation,
  contactGroups,
  contactPhotos,
  contacts,
  drafts,
  groups,
  interactionPeriods,
  notes,
  reminders,
  type Contact,
  type ContactChange,
  type ContactEducation,
  type Draft,
  type Group,
  type InteractionPeriod,
  type Note,
  type Reminder,
} from "@/db/schema";
import { GROUP_COLORS } from "@/lib/format";
import { changeRowsFromPatch } from "@/lib/contact-merge";
import { reconnectSuggestions } from "@/lib/reconnect";
import { getSettings } from "@/lib/actions/settings";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function revalidateAll() {
  revalidatePath("/", "layout");
}

// ---------- Contacts ----------

export type ContactInput = {
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  emails?: string[];
  phoneNumbers?: string[];
  linkedinUrl?: string;
  birthday?: string | null;
  location?: string;
  groupIds?: number[];
};

export async function createContact(input: ContactInput): Promise<number> {
  const db = getDb();
  const fullName = [input.firstName?.trim(), input.lastName?.trim()]
    .filter(Boolean)
    .join(" ");
  const name =
    fullName ||
    input.emails?.[0] ||
    input.phoneNumbers?.[0] ||
    "Unnamed person";

  const [row] = await db
    .insert(contacts)
    .values({
      fullName: name,
      firstName: input.firstName?.trim() || null,
      lastName: input.lastName?.trim() || null,
      company: input.company?.trim() || null,
      title: input.title?.trim() || null,
      emails: input.emails?.filter(Boolean) ?? [],
      phoneNumbers: input.phoneNumbers?.filter(Boolean) ?? [],
      linkedinUrl: input.linkedinUrl?.trim() || null,
      birthday: input.birthday || null,
      location: input.location?.trim() || null,
      source: "manual",
      firstInteractionDate: today(),
      lastInteractionDate: today(),
    })
    .returning({ id: contacts.id });

  if (input.groupIds?.length) {
    await db
      .insert(contactGroups)
      .values(input.groupIds.map((groupId) => ({ contactId: row.id, groupId })))
      .onConflictDoNothing();
  }
  revalidateAll();
  return row.id;
}

export type ContactPatch = Partial<{
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  headline: string | null;
  emails: string[];
  phoneNumbers: string[];
  linkedinUrl: string | null;
  birthday: string | null;
  location: string | null;
}>;

/** Manual edits to these fields show up in the change feed. */
const MANUAL_TRACKED_FIELDS = [
  "fullName",
  "company",
  "title",
  "headline",
  "emails",
  "phoneNumbers",
  "linkedinUrl",
  "location",
] as const;

export async function updateContact(id: number, patch: ContactPatch) {
  const db = getDb();
  const [current] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!current) return;

  const clean: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    clean[k] = typeof v === "string" ? v.trim() || null : v;
  }
  // A new location invalidates the cached coordinates, so the map re-resolves
  // instead of pointing at the old address forever.
  if ("location" in patch) {
    clean.latitude = null;
    clean.longitude = null;
    clean.geocodedAt = null;
  }
  // Keep fullName in sync when names change
  if ("firstName" in patch || "lastName" in patch) {
    const first =
      "firstName" in patch ? (clean.firstName as string | null) : current.firstName;
    const last =
      "lastName" in patch ? (clean.lastName as string | null) : current.lastName;
    const joined = [first, last].filter(Boolean).join(" ");
    if (joined) clean.fullName = joined;
  }
  await db.update(contacts).set(clean).where(eq(contacts.id, id));

  const changeRows = changeRowsFromPatch(current, clean, "manual", MANUAL_TRACKED_FIELDS);
  if (changeRows.length) {
    // Headline keeps only its latest change — previous role → new role
    if (changeRows.some((r) => r.field === "headline")) {
      await db
        .delete(contactChanges)
        .where(
          and(eq(contactChanges.contactId, id), eq(contactChanges.field, "headline")),
        );
    }
    await db.insert(contactChanges).values(changeRows);
  }
  revalidateAll();
}

export async function setStarred(id: number, starred: boolean) {
  const db = getDb();
  await db
    .update(contacts)
    .set({ starred, updatedAt: new Date() })
    .where(eq(contacts.id, id));
  revalidateAll();
}

export async function setArchived(id: number, archived: boolean) {
  const db = getDb();
  await db
    .update(contacts)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(eq(contacts.id, id));
  revalidateAll();
}

/**
 * A contact's PDF without its bytes. The base64 column must never ride this
 * query — a person with four résumés attached would otherwise push megabytes
 * through the RSC payload on every click.
 */
export type ContactDocMeta = {
  id: number;
  filename: string;
  byteSize: number;
};

export type ContactDetail = {
  contact: Contact;
  notes: Note[];
  reminders: Reminder[];
  /** Sent ones included — the card renders that state and it belongs in the history. */
  drafts: Draft[];
  groupIds: number[];
  changes: ContactChange[];
  periods: InteractionPeriod[];
  hasPhoto: boolean;
  education: ContactEducation[];
  docs: ContactDocMeta[];
};

export async function getContactDetail(
  id: number,
): Promise<ContactDetail | null> {
  const db = getDb();
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!contact) return null;

  // Parallel on purpose: every one of these is a separate HTTPS round trip over
  // neon-http, and they were sequential — seven serial round trips on every
  // person click. They share no data, so Promise.all collapses the whole set to
  // roughly one trip's latency.
  const [
    noteRows,
    reminderRows,
    draftRows,
    groupRows,
    changeRows,
    periodRows,
    photoRows,
    educationRows,
    docRows,
  ] = await Promise.all([
      db.select().from(notes).where(eq(notes.contactId, id)).orderBy(desc(notes.createdAt)),
      db
        .select()
        .from(reminders)
        .where(eq(reminders.contactId, id))
        .orderBy(desc(reminders.createdAt)),
      db
        .select()
        .from(drafts)
        .where(eq(drafts.contactId, id))
        .orderBy(desc(drafts.createdAt)),
      db
        .select({ groupId: contactGroups.groupId })
        .from(contactGroups)
        .where(eq(contactGroups.contactId, id)),
      db
        .select()
        .from(contactChanges)
        .where(eq(contactChanges.contactId, id))
        .orderBy(desc(contactChanges.createdAt))
        .limit(20),
      db
        .select()
        .from(interactionPeriods)
        .where(eq(interactionPeriods.contactId, id))
        .orderBy(desc(interactionPeriods.month)),
      db
        .select({ contactId: contactPhotos.contactId })
        .from(contactPhotos)
        .where(eq(contactPhotos.contactId, id)),
      // Most recent first. Postgres orders DESC as NULLS FIRST, which is what
      // we want here for free: a null endYear means "still there", and that
      // belongs above a finished degree.
      db
        .select()
        .from(contactEducation)
        .where(eq(contactEducation.contactId, id))
        .orderBy(desc(contactEducation.endYear), desc(contactEducation.startYear), desc(contactEducation.id)),
      // Explicit column list: the base64 PDF bytes must never ride this query.
      db
        .select({
          id: contactDocs.id,
          filename: contactDocs.filename,
          byteSize: contactDocs.byteSize,
        })
        .from(contactDocs)
        .where(eq(contactDocs.contactId, id))
        .orderBy(desc(contactDocs.createdAt)),
    ]);

  return {
    contact,
    notes: noteRows,
    reminders: reminderRows,
    drafts: draftRows,
    groupIds: groupRows.map((g) => g.groupId),
    changes: changeRows,
    periods: periodRows,
    hasPhoto: photoRows.length > 0,
    education: educationRows,
    docs: docRows,
  };
}

// ---------- Education ----------

/**
 * Years come off number inputs, so they arrive as strings or empty. Anything
 * outside a plausible range becomes null rather than an error — this is a
 * biography field, not a form to be argued with.
 */
function parseYear(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1900 || n > 2100) return null;
  return n;
}

export type EducationPatch = Partial<{
  school: string;
  degree: string | null;
  startYear: string | number | null;
  endYear: string | number | null;
}>;

export async function addEducation(contactId: number): Promise<ContactEducation> {
  const [row] = await getDb()
    .insert(contactEducation)
    // Deliberately blank: the row is created by the "Add" button and filled in
    // by typing into it, same as how a new note starts empty. `school` is
    // NOT NULL, so it needs a value now and gets a real one on first blur.
    .values({ contactId, school: "" })
    .returning();
  revalidateAll();
  return row;
}

export async function updateEducation(id: number, patch: EducationPatch): Promise<void> {
  const clean: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.school !== undefined) clean.school = patch.school.trim();
  if (patch.degree !== undefined) clean.degree = patch.degree?.trim() || null;
  if (patch.startYear !== undefined) clean.startYear = parseYear(patch.startYear);
  if (patch.endYear !== undefined) clean.endYear = parseYear(patch.endYear);

  await getDb().update(contactEducation).set(clean).where(eq(contactEducation.id, id));
  revalidateAll();
}

export async function removeEducation(id: number): Promise<void> {
  await getDb().delete(contactEducation).where(eq(contactEducation.id, id));
  revalidateAll();
}

// ---------- Documents ----------

/**
 * PDFs only, capped at 5MB — the same limit as application docs, and the same
 * reason: next.config.ts's serverActions.bodySizeLimit is 6mb, leaving headroom
 * for the multipart wrapper.
 */
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const PDF_LIMIT_LABEL = "5MB";

export type ContactDocUploadResult =
  | { ok: true; doc: ContactDocMeta }
  | { ok: false; error: string };

/**
 * Attach a PDF. Unlike application docs there are no fixed slots, so this only
 * ever inserts — "replacing" a file is remove + upload. Rows are therefore
 * never mutated, which is what makes the immutable Cache-Control on
 * /api/contact-docs/[id] safe.
 */
export async function uploadContactDoc(
  contactId: number,
  formData: FormData,
): Promise<ContactDocUploadResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "No file received." };
  // Checked before arrayBuffer() so an oversize file is never buffered.
  if (file.size > MAX_PDF_BYTES) {
    return { ok: false, error: `Keep it under ${PDF_LIMIT_LABEL}.` };
  }

  const buf = Buffer.from(await file.arrayBuffer());
  // Magic bytes, not the MIME type — file.type is whatever the browser guessed
  // from the extension, and this gets served back same-origin.
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, error: "That file isn't a PDF." };
  }

  const filename = (file.name || "document.pdf").trim().slice(0, 200) || "document.pdf";
  const [row] = await getDb()
    .insert(contactDocs)
    .values({
      contactId,
      filename,
      data: buf.toString("base64"),
      byteSize: buf.byteLength,
    })
    .returning({
      id: contactDocs.id,
      filename: contactDocs.filename,
      byteSize: contactDocs.byteSize,
    });
  revalidateAll();
  return { ok: true, doc: row };
}

export async function removeContactDoc(docId: number): Promise<void> {
  await getDb().delete(contactDocs).where(eq(contactDocs.id, docId));
  revalidateAll();
}

// ---------- Notes ----------

export async function addNote(contactId: number, body: string): Promise<Note> {
  const db = getDb();
  const [note] = await db
    .insert(notes)
    .values({ contactId, body: body.trim(), source: "manual" })
    .returning();
  await db
    .update(contacts)
    .set({ lastInteractionDate: today(), updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
  revalidateAll();
  return note;
}

export async function updateNote(id: number, body: string) {
  const db = getDb();
  await db
    .update(notes)
    .set({ body: body.trim(), updatedAt: new Date() })
    .where(eq(notes.id, id));
  revalidateAll();
}

export async function deleteNote(id: number) {
  const db = getDb();
  await db.delete(notes).where(eq(notes.id, id));
  revalidateAll();
}

// ---------- Groups ----------

export async function createGroup(name: string): Promise<Group> {
  const db = getDb();
  const existing = await db.select().from(groups);
  const color = GROUP_COLORS[existing.length % GROUP_COLORS.length];
  const [group] = await db
    .insert(groups)
    .values({ name: name.trim(), color })
    .onConflictDoNothing()
    .returning();
  revalidateAll();
  if (!group) {
    const [g] = await db.select().from(groups).where(eq(groups.name, name.trim()));
    return g;
  }
  return group;
}

export async function renameGroup(id: number, name: string) {
  const db = getDb();
  await db.update(groups).set({ name: name.trim() }).where(eq(groups.id, id));
  revalidateAll();
}

export async function deleteGroup(id: number) {
  const db = getDb();
  await db.delete(groups).where(eq(groups.id, id));
  revalidateAll();
}

export async function addToGroup(contactId: number, groupId: number) {
  const db = getDb();
  await db
    .insert(contactGroups)
    .values({ contactId, groupId })
    .onConflictDoNothing();
  revalidateAll();
}

export async function removeFromGroup(contactId: number, groupId: number) {
  const db = getDb();
  await db
    .delete(contactGroups)
    .where(
      and(
        eq(contactGroups.contactId, contactId),
        eq(contactGroups.groupId, groupId),
      ),
    );
  revalidateAll();
}

// ---------- List queries (used by server components) ----------

export type PersonRow = {
  id: number;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  starred: boolean;
  hasLinkedin: boolean;
  hasNotes: boolean;
  hasPhoto: boolean;
  groupIds: number[];
  archived: boolean;
  createdAt: string;
  lastInteractionDate: string | null;
  birthday: string | null;
};

export async function listPeople(): Promise<PersonRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      company: contacts.company,
      title: contacts.title,
      starred: contacts.starred,
      linkedinUrl: contacts.linkedinUrl,
      archivedAt: contacts.archivedAt,
      createdAt: contacts.createdAt,
      lastInteractionDate: contacts.lastInteractionDate,
      birthday: contacts.birthday,
    })
    .from(contacts)
    .orderBy(asc(contacts.fullName));

  const links = await db
    .select({ contactId: contactGroups.contactId, groupId: contactGroups.groupId })
    .from(contactGroups);
  const noteRows = await db
    .select({ contactId: notes.contactId })
    .from(notes);
  const photoRows = await db
    .select({ contactId: contactPhotos.contactId })
    .from(contactPhotos);

  const groupsByContact = new Map<number, number[]>();
  for (const l of links) {
    const arr = groupsByContact.get(l.contactId) ?? [];
    arr.push(l.groupId);
    groupsByContact.set(l.contactId, arr);
  }
  const noted = new Set(noteRows.map((n) => n.contactId));
  const photographed = new Set(photoRows.map((p) => p.contactId));

  return rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    firstName: r.firstName,
    lastName: r.lastName,
    company: r.company,
    title: r.title,
    starred: r.starred,
    hasLinkedin: !!r.linkedinUrl,
    hasNotes: noted.has(r.id),
    hasPhoto: photographed.has(r.id),
    groupIds: groupsByContact.get(r.id) ?? [],
    archived: !!r.archivedAt,
    createdAt: r.createdAt.toISOString(),
    lastInteractionDate: r.lastInteractionDate,
    birthday: r.birthday,
  }));
}

/**
 * Wraps `reconnectSuggestions` for callers (Drafts) that don't already have
 * `listPeople()`/`getSettings()` in scope the way Home's page does — Home
 * calls the pure function directly to avoid a duplicate people query.
 */
export async function listReconnectSuggestions(
  limit?: number,
): Promise<PersonRow[]> {
  const [people, settings] = await Promise.all([listPeople(), getSettings()]);
  return reconnectSuggestions(people, settings.reconnectAfterMonths, limit);
}

export async function listGroups(): Promise<
  (Group & { memberCount: number })[]
> {
  const db = getDb();
  const gs = await db.select().from(groups).orderBy(asc(groups.createdAt));
  const links = await db
    .select({ groupId: contactGroups.groupId })
    .from(contactGroups);
  const counts = new Map<number, number>();
  for (const l of links) counts.set(l.groupId, (counts.get(l.groupId) ?? 0) + 1);
  return gs.map((g) => ({ ...g, memberCount: counts.get(g.id) ?? 0 }));
}

export type NoteFeedItem = {
  id: number;
  body: string;
  source: "imported" | "manual";
  createdAt: string;
  contactId: number;
  contactName: string;
};

export type ChangeFeedItem = {
  id: number;
  contactId: number;
  contactName: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  source: ContactChange["source"];
  createdAt: string;
};

export async function listRecentChanges(days = 14): Promise<ChangeFeedItem[]> {
  const db = getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: contactChanges.id,
      contactId: contactChanges.contactId,
      contactName: contacts.fullName,
      field: contactChanges.field,
      oldValue: contactChanges.oldValue,
      newValue: contactChanges.newValue,
      source: contactChanges.source,
      createdAt: contactChanges.createdAt,
    })
    .from(contactChanges)
    .innerJoin(contacts, eq(contactChanges.contactId, contacts.id))
    .where(gte(contactChanges.createdAt, cutoff))
    .orderBy(desc(contactChanges.createdAt))
    .limit(200);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function listAllNotes(): Promise<NoteFeedItem[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: notes.id,
      body: notes.body,
      source: notes.source,
      createdAt: notes.createdAt,
      contactId: notes.contactId,
      contactName: contacts.fullName,
    })
    .from(notes)
    .innerJoin(contacts, eq(notes.contactId, contacts.id))
    .orderBy(desc(notes.createdAt))
    .limit(500);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
