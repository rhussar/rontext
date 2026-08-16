/**
 * Data export — the producer side of the importer that has always existed.
 *
 * Two shapes:
 *
 * - CSV: the combined_contacts.csv layout that importCsvText() reads (Mesh's
 *   own export plus the LinkedIn columns), one row per non-archived contact.
 *   Round-trips cleanly: importing the file back is a no-op, which is the
 *   test for "did the export lose anything the importer cares about". The
 *   `notes` column carries only the contact's *imported* note, because the
 *   importer creates one imported note per contact and would otherwise turn
 *   every hand-written note into a duplicate on re-import.
 *
 * - JSON: everything human-authored or human-meaningful — contacts (incl.
 *   archived), groups, memberships, notes, reminders, drafts, change history,
 *   interaction counts, social posts, applications. Deliberately no binary
 *   tables (photos, logos, PDFs, post media): those would take a ~50MB
 *   snapshot to hundreds of MB, and they're all re-derivable or re-uploadable.
 *   The nightly backup job writes exactly this document.
 *
 * Pure module, not "use server": the export route and the backup job both
 * call it, and both are already behind their own auth.
 */
import Papa from "papaparse";
import { asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  applications,
  contactChanges,
  contactGroups,
  contacts,
  drafts,
  groups,
  interactionPeriods,
  interactions,
  notes,
  reminders,
  socialPosts,
} from "@/db/schema";

/** Column order of the CSV — the importer's expected headers, in a readable order. */
export const CSV_COLUMNS = [
  "full_name",
  "first_name",
  "last_name",
  "company",
  "title",
  "headline",
  "emails",
  "phone_numbers",
  "linkedin_url",
  "birthday",
  "location",
  "groups",
  "linkedin_connected_on",
  "last_linkedin_message_date",
  "first_interaction_date",
  "last_interaction_date",
  "interaction_sources",
  "mesh_id",
  "mesh_url",
  "notes",
] as const;

export async function contactsCsv(): Promise<string> {
  const db = getDb();
  const [people, memberships, groupRows, importedNotes] = await Promise.all([
    db.select().from(contacts).where(isNull(contacts.archivedAt)).orderBy(asc(contacts.id)),
    db.select().from(contactGroups),
    db.select({ id: groups.id, name: groups.name }).from(groups),
    db
      .select({ contactId: notes.contactId, body: notes.body })
      .from(notes)
      .where(eq(notes.source, "imported")),
  ]);
  const groupName = new Map(groupRows.map((g) => [g.id, g.name]));
  const groupsOf = new Map<number, string[]>();
  for (const m of memberships) {
    const name = groupName.get(m.groupId);
    if (!name) continue;
    const list = groupsOf.get(m.contactId) ?? [];
    list.push(name);
    groupsOf.set(m.contactId, list);
  }
  const noteOf = new Map(importedNotes.map((n) => [n.contactId, n.body]));

  const rows = people.map((c) => {
    const g = [...(groupsOf.get(c.id) ?? [])].sort();
    // The importer reads "Starred" out of the groups column, so it goes back there.
    if (c.starred) g.unshift("Starred");
    return {
      full_name: c.fullName,
      first_name: c.firstName ?? "",
      last_name: c.lastName ?? "",
      company: c.company ?? "",
      title: c.title ?? "",
      headline: c.headline ?? "",
      emails: c.emails.join("; "),
      phone_numbers: c.phoneNumbers.join("; "),
      linkedin_url: c.linkedinUrl ?? "",
      birthday: c.birthday ?? "",
      location: c.location ?? "",
      groups: g.join("; "),
      linkedin_connected_on: c.linkedinConnectedOn ?? "",
      last_linkedin_message_date: c.lastLinkedinMessageDate ?? "",
      first_interaction_date: c.firstInteractionDate ?? "",
      last_interaction_date: c.lastInteractionDate ?? "",
      interaction_sources: c.interactionSources.join("; "),
      mesh_id: c.meshId ?? "",
      mesh_url: c.meshUrl ?? "",
      notes: noteOf.get(c.id) ?? "",
    };
  });

  return Papa.unparse(rows, { columns: [...CSV_COLUMNS], newline: "\n" });
}

export type Snapshot = {
  format: "rontext-snapshot";
  version: 1;
  exportedAt: string;
  tables: Record<string, unknown[]>;
  counts: Record<string, number>;
};

export async function snapshotJson(): Promise<Snapshot> {
  const db = getDb();
  const [
    contactRows,
    groupRows,
    membershipRows,
    noteRows,
    reminderRows,
    draftRows,
    changeRows,
    interactionRows,
    periodRows,
    postRows,
    applicationRows,
  ] = await Promise.all([
    db.select().from(contacts).orderBy(asc(contacts.id)),
    db.select().from(groups),
    db.select().from(contactGroups),
    db.select().from(notes),
    db.select().from(reminders),
    db.select().from(drafts),
    db.select().from(contactChanges),
    db.select().from(interactions),
    db.select().from(interactionPeriods),
    db.select().from(socialPosts),
    db.select().from(applications),
  ]);
  const tables: Record<string, unknown[]> = {
    contacts: contactRows,
    groups: groupRows,
    contact_groups: membershipRows,
    notes: noteRows,
    reminders: reminderRows,
    drafts: draftRows,
    contact_changes: changeRows,
    interactions: interactionRows,
    interaction_periods: periodRows,
    social_posts: postRows,
    applications: applicationRows,
  };
  return {
    format: "rontext-snapshot",
    version: 1,
    exportedAt: new Date().toISOString(),
    tables,
    counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
  };
}

/** `rontext-2026-08-15.csv` — date-stamped so downloads don't overwrite each other. */
export function exportFilename(ext: "csv" | "json", now = new Date()): string {
  return `rontext-${now.toISOString().slice(0, 10)}.${ext}`;
}
