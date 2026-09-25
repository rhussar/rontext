/**
 * Adding people from an agent — the MCP `add_contacts` tool.
 *
 * The app could always create contacts (the Add person dialog, CSV import,
 * the classbook script), but none of those is reachable by an agent: an
 * agent handed a roster could search the book and then had to stop. This is
 * that missing write, shaped by the same rules as the other agent tools:
 *
 *  - Never a guess. A row joins an existing contact only on proof: an
 *    explicit `contactId`, or an email / phone / LinkedIn that resolves to
 *    exactly one person (lookupContacts — the connectors' own keys). A
 *    same-name contact with nothing else in common is reported back as
 *    `name_match`, untouched, for the agent to confirm (resend with
 *    `contactId`) or rule out (resend with `forceCreate`). Two Jon Smiths are
 *    exactly the case where a guess files notes on the wrong person.
 *  - Never overwrites. An existing contact's fields stay as they are; it only
 *    gains the requested groups, the note, and the "known from" label, all
 *    additive. Fill-in-the-blanks is the owner's call, in the app.
 *  - Not an interaction. Like add_note, an agent adding someone isn't the
 *    owner being in touch, so no interaction dates are set — otherwise a
 *    roster import would read as fifty fresh conversations and bury real
 *    reconnect suggestions.
 *  - Idempotent in effect. Resending a batch creates nothing twice: rows
 *    come back `name_match` (or `matched` by identifier), and a note whose
 *    exact text is already on the contact is not added again.
 *
 * New contacts are source "import" (as the CSV and classbook importers are)
 * with an "added" change row; notes are agent notes filed under the caller.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
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
import { emailLookupKey, lookupContacts, phoneLookupKey } from "@/lib/contact-lookup";
import { linkedinKey } from "@/lib/contact-merge";
import { GROUP_COLORS } from "@/lib/format";

export const ADD_CONTACTS_MAX = 100;

export type AgentContactInput = {
  fullName: string;
  firstName?: string;
  lastName?: string;
  emails?: string[];
  phones?: string[];
  linkedinUrl?: string;
  company?: string;
  title?: string;
  location?: string;
  hometown?: string;
  school?: string;
  note?: string;
  /** The existing contact this row is, confirmed by the caller. */
  contactId?: number;
  /** A same-name contact was checked and is someone else: create anyway. */
  forceCreate?: boolean;
};

export type AddContactsRowStatus =
  | "created"
  | "matched"
  | "name_match"
  | "ambiguous"
  | "archived"
  | "duplicate_in_batch"
  | "invalid";

export type AddContactsRow = {
  row: number;
  name: string;
  status: AddContactsRowStatus;
  contactId?: number;
  /** How a `matched` row was matched. */
  matchedBy?: "contact_id" | "email" | "phone" | "linkedin";
  /** Existing contacts the row could be — for name_match and ambiguous. */
  candidates?: { id: number; fullName: string; company: string | null; title: string | null }[];
  reason?: string;
  groupsAdded?: string[];
  noteAdded?: boolean;
};

export type AddContactsResult = {
  ok: boolean;
  dryRun: boolean;
  created: number;
  matched: number;
  notTouched: number;
  groupsCreated: string[];
  results: AddContactsRow[];
  error?: string;
};

const nameKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const clean = (s: string | undefined) => s?.trim().replace(/\s+/g, " ") || null;
const cleanList = (xs: string[] | undefined) => [...new Set((xs ?? []).map((x) => x.trim()).filter(Boolean))];

export async function addContacts(opts: {
  people: AgentContactInput[];
  groups?: string[];
  /** Shown on the profile as "Known from: …"; e.g. "2Y directory". */
  knownFrom?: string;
  author: string;
  dryRun?: boolean;
}): Promise<AddContactsResult> {
  const dryRun = opts.dryRun ?? false;
  const knownFrom = clean(opts.knownFrom);
  // One entry per name, case-insensitively; the first spelling given wins.
  const groupNames = cleanList(opts.groups).filter(
    (g, i, all) => all.findIndex((x) => x.toLowerCase() === g.toLowerCase()) === i,
  );
  const out: AddContactsResult = {
    ok: false,
    dryRun,
    created: 0,
    matched: 0,
    notTouched: 0,
    groupsCreated: [],
    results: [],
  };
  if (opts.people.length > ADD_CONTACTS_MAX) {
    out.error = `At most ${ADD_CONTACTS_MAX} people per call — split the batch`;
    return out;
  }
  const db = getDb();

  // --- Resolve every row to create / existing / leave-alone ---------------
  type Plan =
    | { kind: "create"; p: AgentContactInput; name: string; row: number }
    | { kind: "existing"; p: AgentContactInput; name: string; row: number; id: number; by: AddContactsRow["matchedBy"] };
  const plans: Plan[] = [];

  const lookups = await lookupContacts({
    emails: opts.people.flatMap((p) => cleanList(p.emails)),
    phones: opts.people.flatMap((p) => cleanList(p.phones)),
    linkedinUrls: opts.people.flatMap((p) => cleanList(p.linkedinUrl ? [p.linkedinUrl] : [])),
  });
  const byInput = new Map(lookups.map((l) => [`${l.kind}:${l.input}`, l]));

  const wantedNames = [...new Set(opts.people.map((p) => nameKey(p.fullName)).filter(Boolean))];
  const explicitIds = opts.people.flatMap((p) => (p.contactId ? [p.contactId] : []));
  const known = wantedNames.length || explicitIds.length
    ? await db
        .select({
          id: contacts.id,
          fullName: contacts.fullName,
          company: contacts.company,
          title: contacts.title,
          archivedAt: contacts.archivedAt,
        })
        .from(contacts)
        .where(
          sql`lower(regexp_replace(trim(${contacts.fullName}), '\\s+', ' ', 'g')) in (select jsonb_array_elements_text(${JSON.stringify(wantedNames)}::jsonb))
              or ${contacts.id} in (select (jsonb_array_elements_text(${JSON.stringify(explicitIds)}::jsonb))::int)`,
        )
    : [];
  const byId = new Map(known.map((c) => [c.id, c]));
  const candidate = (c: (typeof known)[number]) => ({
    id: c.id,
    fullName: c.fullName,
    company: c.company,
    title: c.title,
  });

  // Keys already claimed by an earlier row of this batch.
  const seen = new Map<string, number>();
  const batchKeys = (p: AgentContactInput) => [
    `name:${nameKey(p.fullName)}`,
    ...cleanList(p.emails).flatMap((e) => (emailLookupKey(e) ? [`email:${emailLookupKey(e)}`] : [])),
    ...cleanList(p.phones).flatMap((ph) => (phoneLookupKey(ph) ? [`phone:${phoneLookupKey(ph)}`] : [])),
    ...(linkedinKey(p.linkedinUrl) ? [`linkedin:${linkedinKey(p.linkedinUrl)}`] : []),
  ];

  opts.people.forEach((p, i) => {
    const row = i + 1;
    const name = clean(p.fullName) ?? "";
    const skip = (status: AddContactsRowStatus, extra: Partial<AddContactsRow> = {}) => {
      out.results.push({ row, name, status, ...extra });
      out.notTouched++;
    };
    if (!name) return skip("invalid", { reason: "fullName is empty" });
    if (p.contactId && p.forceCreate) {
      return skip("invalid", { reason: "Give contactId or forceCreate, not both" });
    }

    // A name repeated inside the batch is the same person listed twice
    // unless the caller has said otherwise with forceCreate.
    const keys = batchKeys(p).filter((k) => !(p.forceCreate && k.startsWith("name:")));
    const dupOf = keys.map((k) => seen.get(k)).find((r) => r !== undefined);
    if (dupOf !== undefined) {
      return skip("duplicate_in_batch", { reason: `Same person as row ${dupOf}; merge the two rows` });
    }
    keys.forEach((k) => seen.set(k, row));

    if (p.contactId) {
      const c = byId.get(p.contactId);
      if (!c) return skip("invalid", { reason: `No contact with id ${p.contactId}` });
      if (c.archivedAt) return skip("archived", { contactId: c.id, reason: "Archived — the owner decides whether to restore" });
      plans.push({ kind: "existing", p, name, row, id: c.id, by: "contact_id" });
      return;
    }

    // Identifiers are proof; collect every contact they point at.
    const hits = new Map<number, { by: AddContactsRow["matchedBy"]; m: { id: number; fullName: string; company: string | null; title: string | null; archived: boolean } }>();
    const collect = (kind: "email" | "phone" | "linkedin", raw: string) => {
      for (const m of byInput.get(`${kind}:${raw}`)?.matches ?? []) {
        if (!hits.has(m.id)) hits.set(m.id, { by: kind, m });
      }
    };
    cleanList(p.emails).forEach((e) => collect("email", e));
    cleanList(p.phones).forEach((ph) => collect("phone", ph));
    cleanList(p.linkedinUrl ? [p.linkedinUrl] : []).forEach((u) => collect("linkedin", u));

    if (hits.size > 1) {
      return skip("ambiguous", {
        reason: "Its email/phone/LinkedIn belong to different contacts",
        candidates: [...hits.values()].map(({ m }) => ({ id: m.id, fullName: m.fullName, company: m.company, title: m.title })),
      });
    }
    if (hits.size === 1) {
      const [{ by, m }] = [...hits.values()];
      if (m.archived) return skip("archived", { contactId: m.id, reason: "Archived — the owner decides whether to restore" });
      plans.push({ kind: "existing", p, name, row, id: m.id, by });
      return;
    }

    if (!p.forceCreate) {
      const same = known.filter((c) => nameKey(c.fullName) === nameKey(name));
      if (same.length) {
        return skip("name_match", {
          reason:
            "A contact with this name exists. If it's the same person, resend the row with contactId; " +
            "if not, resend with forceCreate",
          candidates: same.map(candidate),
        });
      }
    }
    plans.push({ kind: "create", p, name, row });
  });

  // --- Groups: find by name (case-insensitive), create the missing ones ----
  const allGroups = groupNames.length ? await db.select().from(groups) : [];
  const groupByKey = new Map(allGroups.map((g) => [g.name.toLowerCase(), g]));
  const touchesAnyone = plans.length > 0;
  for (const name of groupNames) {
    if (groupByKey.has(name.toLowerCase())) continue;
    out.groupsCreated.push(name);
    if (dryRun || !touchesAnyone) continue;
    const color = GROUP_COLORS[(allGroups.length + out.groupsCreated.length - 1) % GROUP_COLORS.length];
    const [g] = await db.insert(groups).values({ name, color }).onConflictDoNothing().returning();
    // Lost a race with someone creating the same name: read theirs.
    const row = g ?? (await db.select().from(groups).where(eq(groups.name, name)))[0];
    if (row) groupByKey.set(name.toLowerCase(), row);
  }
  if (!touchesAnyone) out.groupsCreated = [];
  const targetGroups = groupNames.flatMap((n) => {
    const g = groupByKey.get(n.toLowerCase());
    return g ? [g] : [];
  });

  // --- Create --------------------------------------------------------------
  const creates = plans.filter((p): p is Extract<Plan, { kind: "create" }> => p.kind === "create");
  const createdIds: number[] = [];
  if (creates.length && !dryRun) {
    const values: NewContact[] = creates.map(({ p, name }) => {
      const space = name.indexOf(" ");
      return {
        fullName: name,
        firstName: clean(p.firstName) ?? (space > 0 ? name.slice(0, space) : name),
        lastName: clean(p.lastName) ?? (space > 0 ? name.slice(space + 1) : null),
        company: clean(p.company),
        title: clean(p.title),
        emails: cleanList(p.emails),
        phoneNumbers: cleanList(p.phones),
        linkedinUrl: clean(p.linkedinUrl),
        location: clean(p.location),
        hometown: clean(p.hometown),
        interactionSources: knownFrom ? [knownFrom] : [],
        source: "import",
      };
    });
    const returned = await db.insert(contacts).values(values).returning({ id: contacts.id });
    createdIds.push(...returned.map((r) => r.id));
    await db.insert(contactChanges).values(
      creates.map(({ name }, i) => ({
        contactId: createdIds[i],
        field: "added",
        oldValue: null,
        newValue: name,
        source: "import" as const,
      })),
    );
    const schools = creates.flatMap(({ p }, i) =>
      clean(p.school) ? [{ contactId: createdIds[i], school: clean(p.school)! }] : [],
    );
    if (schools.length) await db.insert(contactEducation).values(schools);
  }

  // --- Existing: additive only ---------------------------------------------
  const existing = plans.filter((p): p is Extract<Plan, { kind: "existing" }> => p.kind === "existing");
  const existingIds = [...new Set(existing.map((e) => e.id))];
  const memberships = existingIds.length && targetGroups.length
    ? await db
        .select({ contactId: contactGroups.contactId, groupId: contactGroups.groupId })
        .from(contactGroups)
        .where(inArray(contactGroups.contactId, existingIds))
    : [];
  const isMember = new Set(memberships.map((m) => `${m.contactId}:${m.groupId}`));
  const existingNotes = existingIds.length
    ? await db
        .select({ contactId: notes.contactId, body: notes.body })
        .from(notes)
        .where(inArray(notes.contactId, existingIds))
    : [];
  const hasNote = new Set(existingNotes.map((n) => `${n.contactId}:${n.body.trim()}`));
  if (knownFrom && existingIds.length && !dryRun) {
    await db
      .update(contacts)
      .set({ interactionSources: sql`array_append(${contacts.interactionSources}, ${knownFrom})` })
      .where(
        and(
          inArray(contacts.id, existingIds),
          sql`not (${knownFrom} = any(${contacts.interactionSources}))`,
        ),
      );
  }

  // --- Groups and notes for everyone touched -------------------------------
  const links: { contactId: number; groupId: number }[] = [];
  const newNotes: { contactId: number; body: string; source: "agent"; author: string }[] = [];
  const createdIdByRow = new Map(creates.map((c, i) => [c.row, createdIds[i]]));
  for (const plan of plans) {
    const id = plan.kind === "create" ? createdIdByRow.get(plan.row) : plan.id;
    const groupsAdded = targetGroups.filter((g) => id === undefined || !isMember.has(`${id}:${g.id}`));
    const body = plan.p.note?.trim();
    const noteAdded = !!body && (id === undefined || !hasNote.has(`${id}:${body}`));
    if (id !== undefined) {
      for (const g of groupsAdded) {
        links.push({ contactId: id, groupId: g.id });
        isMember.add(`${id}:${g.id}`);
      }
      if (noteAdded) {
        newNotes.push({ contactId: id, body: body!, source: "agent", author: opts.author });
        hasNote.add(`${id}:${body}`);
      }
    }
    out.results.push({
      row: plan.row,
      name: plan.name,
      status: plan.kind === "create" ? "created" : "matched",
      ...(id !== undefined ? { contactId: id } : {}),
      ...(plan.kind === "existing" ? { matchedBy: plan.by } : {}),
      ...(groupsAdded.length ? { groupsAdded: groupsAdded.map((g) => g.name) } : {}),
      ...(noteAdded ? { noteAdded } : {}),
    });
    if (plan.kind === "create") out.created++;
    else out.matched++;
  }
  // Group names requested but not yet created (dry run) still show per row.
  if (dryRun) {
    const pending = out.groupsCreated;
    for (const r of out.results) {
      if ((r.status === "created" || r.status === "matched") && pending.length) {
        r.groupsAdded = [...(r.groupsAdded ?? []), ...pending];
      }
    }
  }
  if (!dryRun) {
    if (links.length) await db.insert(contactGroups).values(links).onConflictDoNothing();
    if (newNotes.length) await db.insert(notes).values(newNotes);
    if (plans.length) {
      // Visible without a reload; same as every other contact write.
      try {
        revalidatePath("/", "layout");
      } catch {
        // Outside a request (scripts, tests) there is nothing to revalidate.
      }
    }
  }

  out.results.sort((a, b) => a.row - b.row);
  out.ok = true;
  return out;
}
