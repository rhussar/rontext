import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactChanges,
  contactEducation,
  contactGroups,
  contacts,
  groups,
  notes,
  type NewContact,
} from "@/db/schema";
import { differs } from "@/lib/contact-merge";

/**
 * One page of the "Get to Know Your Class" slide deck. Parsed by Claude from
 * the PDF (text layer where present, page render where not) — the JSON batch
 * file is the whole interface; review it before importing.
 */
export type ClassbookProfile = {
  /** PDF page number, for tracing a row back to its slide. */
  page: number;
  name: string;
  pronouns?: string;
  hometown?: string;
  preSom?: string;
  interests?: string;
  nationality?: string;
  /** Free text as written on the slide (may include degree, honors, etc.). */
  education?: string;
  /** Cleaned school name for a contact_education row. Fill-gaps only. */
  school?: string;
  funFact?: string;
  instagram?: string;
  /**
   * Explicit match override for contacts saved under a bare first name
   * (e.g. "Nicole" → Nicole Lin, disambiguated by hand before the run).
   */
  matchContactId?: number;
  /**
   * Skip matching and always create — for when an existing contact with the
   * exact same name turned out to be a different person on review.
   */
  forceCreate?: boolean;
};

export type ClassbookSummary = {
  ok: boolean;
  error?: string;
  profileCount: number;
  created: number;
  matched: number;
  namesUpgraded: number;
  hometownsFilled: number;
  schoolsAdded: number;
  notesAdded: number;
  notesSkipped: number;
  groupLinksAdded: number;
  actions: string[];
};

const notePrefix = (cohort: string) => `Yale SOM classbook (${cohort} Cohort)`;

function buildNote(p: ClassbookProfile, cohort: string): string {
  const lines = [`${notePrefix(cohort)}:`];
  if (p.hometown) lines.push(`Hometown: ${p.hometown}`);
  if (p.preSom) lines.push(`Pre-SOM: ${p.preSom}`);
  if (p.education) lines.push(`Education: ${p.education}`);
  if (p.nationality) lines.push(`Nationality: ${p.nationality}`);
  if (p.interests) lines.push(`Interests: ${p.interests}`);
  if (p.funFact) lines.push(`Fun fact: ${p.funFact}`);
  if (p.instagram) lines.push(`Instagram: @${p.instagram.replace(/^@/, "")}`);
  if (p.pronouns) lines.push(`Pronouns: ${p.pronouns}`);
  return lines.join("\n");
}

const nameKey = (s: string) => s.trim().toLowerCase();
const schoolKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function ingestClassbookProfiles(
  profiles: ClassbookProfile[],
  opts: { cohort: string; dryRun?: boolean; extraGroups?: string[] },
): Promise<ClassbookSummary> {
  const { cohort } = opts;
  const dryRun = opts.dryRun ?? false;
  const summary: ClassbookSummary = {
    ok: false,
    profileCount: profiles.length,
    created: 0,
    matched: 0,
    namesUpgraded: 0,
    hometownsFilled: 0,
    schoolsAdded: 0,
    notesAdded: 0,
    notesSkipped: 0,
    groupLinksAdded: 0,
    actions: [],
  };
  const act = (s: string) => summary.actions.push(s);

  const db = getDb();

  // Groups: cohort + any extras (e.g. "Yale"), matched case-insensitively,
  // created when absent. Every touched contact is linked to all of them.
  const allGroups = await db.select().from(groups);
  const targetGroups: (typeof allGroups)[number][] = [];
  for (const name of [cohort, ...(opts.extraGroups ?? [])]) {
    let g = allGroups.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!g) {
      if (dryRun) {
        act(`would create group "${name}"`);
        continue;
      }
      const [row] = await db
        .insert(groups)
        .values({ name, color: "#ef4444" })
        .onConflictDoNothing()
        .returning();
      g = row;
    }
    if (g) targetGroups.push(g);
  }
  const group = targetGroups.find((g) => g.name.toLowerCase() === cohort.toLowerCase());

  const existing = await db.select().from(contacts);
  const byId = new Map(existing.map((c) => [c.id, c]));
  const byName = new Map<string, (typeof existing)[number] | "dup">();
  for (const c of existing) {
    const key = nameKey(c.fullName);
    byName.set(key, byName.has(key) ? "dup" : c);
  }
  // Bare-first-name contacts already in the cohort group can match by first
  // name alone — but only when exactly one classbook profile shares that
  // first name, so "Nicole" can never silently pick between two Nicoles.
  const memberIdsByGroup = new Map<number, Set<number>>();
  for (const g of targetGroups) {
    memberIdsByGroup.set(
      g.id,
      new Set(
        (
          await db
            .select({ contactId: contactGroups.contactId })
            .from(contactGroups)
            .where(eq(contactGroups.groupId, g.id))
        ).map((r) => r.contactId),
      ),
    );
  }
  const groupMemberIds = group ? memberIdsByGroup.get(group.id)! : new Set<number>();
  const firstNameCounts = new Map<string, number>();
  for (const p of profiles) {
    const first = nameKey(p.name).split(" ")[0];
    firstNameCounts.set(first, (firstNameCounts.get(first) ?? 0) + 1);
  }

  const existingNotes = await db
    .select({ contactId: notes.contactId, body: notes.body })
    .from(notes)
    .where(sql`${notes.body} like ${notePrefix(cohort) + "%"}`);
  const notedContactIds = new Set(existingNotes.map((n) => n.contactId));

  const now = new Date();

  for (const p of profiles) {
    const fullName = p.name.trim();
    if (!fullName) {
      summary.error = `Profile on page ${p.page} has no name`;
      return summary;
    }

    let match = p.matchContactId ? byId.get(p.matchContactId) : undefined;
    if (p.matchContactId && !match) {
      summary.error = `page ${p.page}: matchContactId ${p.matchContactId} not found`;
      return summary;
    }
    if (!match && !p.forceCreate) {
      const hit = byName.get(nameKey(fullName));
      if (hit && hit !== "dup") match = hit;
    }
    if (!match && !p.forceCreate) {
      const first = nameKey(fullName).split(" ")[0];
      if (firstNameCounts.get(first) === 1) {
        const bare = byName.get(first);
        if (bare && bare !== "dup" && !bare.lastName && groupMemberIds.has(bare.id)) {
          match = bare;
        }
      }
    }

    let contactId: number;
    if (!match) {
      const spaceAt = fullName.indexOf(" ");
      const values: NewContact = {
        fullName,
        firstName: spaceAt > 0 ? fullName.slice(0, spaceAt) : fullName,
        lastName: spaceAt > 0 ? fullName.slice(spaceAt + 1) : null,
        hometown: p.hometown?.trim() || null,
        source: "import",
        interactionSources: ["classbook"],
      };
      if (dryRun) {
        act(`would create "${fullName}"`);
        summary.created++;
        continue; // downstream steps need a real id
      }
      const [row] = await db.insert(contacts).values(values).returning({ id: contacts.id });
      contactId = row.id;
      await db.insert(contactChanges).values({
        contactId,
        field: "added",
        oldValue: null,
        newValue: fullName,
        source: "import",
      });
      summary.created++;
      act(`created "${fullName}"`);
    } else {
      contactId = match.id;
      summary.matched++;
      const patch: Partial<NewContact> = {};
      // Upgrade a bare first name to the classbook full name; a real
      // existing last name always wins (user renames are authoritative).
      if (!match.lastName && differs(fullName, match.fullName)) {
        const spaceAt = fullName.indexOf(" ");
        patch.fullName = fullName;
        patch.firstName = spaceAt > 0 ? fullName.slice(0, spaceAt) : fullName;
        patch.lastName = spaceAt > 0 ? fullName.slice(spaceAt + 1) : null;
        summary.namesUpgraded++;
        act(`name: "${match.fullName}" → "${fullName}"`);
      }
      if (p.hometown?.trim() && !match.hometown) {
        patch.hometown = p.hometown.trim();
        summary.hometownsFilled++;
        act(`hometown for "${fullName}": ${patch.hometown}`);
      }
      if (Object.keys(patch).length && !dryRun) {
        await db
          .update(contacts)
          .set({ ...patch, updatedAt: now })
          .where(eq(contacts.id, contactId));
      }
    }

    if (p.school?.trim()) {
      const school = p.school.trim();
      const key = schoolKey(school);
      const rows = await db
        .select({ school: contactEducation.school })
        .from(contactEducation)
        .where(eq(contactEducation.contactId, contactId));
      if (!rows.some((r) => schoolKey(r.school) === key)) {
        if (!dryRun) await db.insert(contactEducation).values({ contactId, school });
        summary.schoolsAdded++;
        act(`school for "${fullName}": ${school}`);
      }
    }

    if (notedContactIds.has(contactId)) {
      summary.notesSkipped++;
    } else {
      if (!dryRun) {
        await db
          .insert(notes)
          .values({ contactId, body: buildNote(p, cohort), source: "imported" });
      }
      summary.notesAdded++;
    }

    for (const g of targetGroups) {
      const members = memberIdsByGroup.get(g.id)!;
      if (members.has(contactId)) continue;
      if (!dryRun) {
        await db
          .insert(contactGroups)
          .values({ contactId, groupId: g.id })
          .onConflictDoNothing();
      }
      members.add(contactId);
      summary.groupLinksAdded++;
    }
  }

  summary.ok = true;
  return summary;
}

/**
 * Undo an ingest: delete contacts this import created (cascade removes their
 * notes, education, and group links) and the classbook notes it added to
 * pre-existing contacts. Education rows and name/hometown fills on matched
 * contacts are left in place — they are fill-gaps enrichments, not history.
 */
export async function revertClassbook(opts: { cohort: string; dryRun?: boolean }) {
  const db = getDb();
  const dryRun = opts.dryRun ?? false;
  const created = await db
    .select({ id: contacts.id, fullName: contacts.fullName })
    .from(contacts)
    .where(
      and(
        eq(contacts.source, "import"),
        sql`'classbook' = any(${contacts.interactionSources})`,
      ),
    );
  const classbookNotes = await db
    .select({ id: notes.id, contactId: notes.contactId })
    .from(notes)
    .where(sql`${notes.body} like ${notePrefix(opts.cohort) + "%"}`);
  const createdIds = new Set(created.map((c) => c.id));
  const noteIdsOnMatched = classbookNotes
    .filter((n) => !createdIds.has(n.contactId))
    .map((n) => n.id);
  if (!dryRun) {
    for (const c of created) await db.delete(contacts).where(eq(contacts.id, c.id));
    for (const id of noteIdsOnMatched) await db.delete(notes).where(eq(notes.id, id));
  }
  return {
    contactsDeleted: created.map((c) => c.fullName),
    notesDeletedOnMatched: noteIdsOnMatched.length,
    dryRun,
  };
}
