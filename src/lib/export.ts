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
 *   interaction counts, education, recorded meetings (with transcripts),
 *   texts summaries, observed ties, the Discovered queue and duplicate
 *   decisions, agent runs, social posts, applications. No binary bytes
 *   (photos, logos, PDFs, post media): those would take a ~50MB snapshot to
 *   hundreds of MB. Photos, logos and post media are re-derivable or
 *   re-uploadable; PDFs are not, so the snapshot lists them (metadata, no
 *   bytes) with `file` naming where the backup job stored the bytes once —
 *   see backupFilePath(). The nightly backup job writes exactly this document.
 *
 * Pure module, not "use server": the export route and the backup job both
 * call it, and both are already behind their own auth.
 */
import Papa from "papaparse";
import { asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  agentRuns,
  applicationDocs,
  applications,
  contactCandidates,
  contactChanges,
  contactDocs,
  contactEducation,
  contactGroups,
  contactLinks,
  contacts,
  dismissedDuplicates,
  drafts,
  groups,
  interactionPeriods,
  interactions,
  meetingContacts,
  meetings,
  notes,
  reminders,
  socialPosts,
  threadSummaries,
} from "@/db/schema";

/** The two tables whose bytes the backup job copies out as files. */
export type BackupFileKind = "contact-docs" | "application-docs";

/**
 * Where the backup job keeps one PDF's bytes. Keyed by row id, which is safe
 * because both tables are insert-only: a replace is a new row under a new id,
 * so a path never needs re-uploading. Outside `backups/` on purpose — that
 * prefix is pruned by upload age, and a PDF is uploaded exactly once.
 */
export function backupFilePath(kind: BackupFileKind, id: number): string {
  return `backup-files/${kind}/${id}.pdf`;
}

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
  version: 2;
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
    educationRows,
    meetingRows,
    meetingContactRows,
    summaryRows,
    linkRows,
    candidateRows,
    dismissedRows,
    agentRunRows,
    contactDocRows,
    applicationDocRows,
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
    db.select().from(contactEducation),
    db.select().from(meetings),
    db.select().from(meetingContacts),
    db.select().from(threadSummaries),
    db.select().from(contactLinks),
    db.select().from(contactCandidates),
    db.select().from(dismissedDuplicates),
    db.select().from(agentRuns),
    // Every column but the bytes — the bytes are files, see backupFilePath().
    db
      .select({
        id: contactDocs.id,
        contactId: contactDocs.contactId,
        filename: contactDocs.filename,
        byteSize: contactDocs.byteSize,
        createdAt: contactDocs.createdAt,
      })
      .from(contactDocs),
    db
      .select({
        id: applicationDocs.id,
        applicationId: applicationDocs.applicationId,
        kind: applicationDocs.kind,
        filename: applicationDocs.filename,
        byteSize: applicationDocs.byteSize,
        createdAt: applicationDocs.createdAt,
      })
      .from(applicationDocs),
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
    contact_education: educationRows,
    meetings: meetingRows,
    meeting_contacts: meetingContactRows,
    thread_summaries: summaryRows,
    contact_links: linkRows,
    contact_candidates: candidateRows,
    dismissed_duplicates: dismissedRows,
    agent_runs: agentRunRows,
    contact_docs: contactDocRows.map((d) => ({ ...d, file: backupFilePath("contact-docs", d.id) })),
    application_docs: applicationDocRows.map((d) => ({
      ...d,
      file: backupFilePath("application-docs", d.id),
    })),
  };
  return {
    format: "rontext-snapshot",
    // 2: adds education, meetings, summaries, ties, the Discovered queue,
    // duplicate decisions, agent runs, and PDF metadata. Every v1 table is
    // unchanged, so a v1 reader still finds what it expects.
    version: 2,
    exportedAt: new Date().toISOString(),
    tables,
    counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
  };
}

/** `rontext-2026-08-15.csv` — date-stamped so downloads don't overwrite each other. */
export function exportFilename(ext: "csv" | "json", now = new Date()): string {
  return `rontext-${now.toISOString().slice(0, 10)}.${ext}`;
}
