import Papa from "papaparse";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactGroups,
  contacts,
  groups,
  imports,
  notes,
  type NewContact,
} from "@/db/schema";
import { GROUP_COLORS, parseCsvDate } from "@/lib/format";

const EXPECTED_COLUMNS = [
  "full_name",
  "linkedin_url",
  "mesh_id",
] as const;

type CsvRow = Record<string, string>;

export type ImportSummary = {
  ok: boolean;
  error?: string;
  rowCount: number;
  created: number;
  updated: number;
  skipped: number;
  notesCreated: number;
  groupsCreated: string[];
};

function splitMulti(v: string | undefined): string[] {
  return (v ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeLinkedin(url: string | undefined): string | null {
  const v = (url ?? "").trim();
  if (!v) return null;
  return v.replace(/\/+$/, "").toLowerCase();
}

function mapRow(row: CsvRow): {
  values: NewContact;
  groupNames: string[];
  noteBody: string | null;
} {
  const groupNames = splitMulti(row.groups);
  const starred = groupNames.some((g) => g.toLowerCase() === "starred");
  const realGroups = groupNames.filter((g) => g.toLowerCase() !== "starred");

  const values: NewContact = {
    fullName: (row.full_name ?? "").trim() || "Unnamed person",
    firstName: (row.first_name ?? "").trim() || null,
    lastName: (row.last_name ?? "").trim() || null,
    company: (row.company ?? "").trim() || null,
    title: (row.title ?? "").trim() || null,
    emails: splitMulti(row.emails),
    phoneNumbers: splitMulti(row.phone_numbers),
    linkedinUrl: normalizeLinkedin(row.linkedin_url),
    birthday: parseCsvDate(row.birthday),
    location: (row.location ?? "").trim() || null,
    starred,
    linkedinConnectedOn: parseCsvDate(row.linkedin_connected_on),
    lastLinkedinMessageDate: parseCsvDate(row.last_linkedin_message_date),
    firstInteractionDate: parseCsvDate(row.first_interaction_date),
    lastInteractionDate: parseCsvDate(row.last_interaction_date),
    interactionSources: splitMulti(row.interaction_sources),
    meshId: (row.mesh_id ?? "").trim() || null,
    meshUrl: (row.mesh_url ?? "").trim() || null,
    source: "import",
  };
  return { values, groupNames: realGroups, noteBody: (row.notes ?? "").trim() || null };
}

/** Fields the importer owns; compared to decide whether an update is needed. */
const COMPARE_KEYS: (keyof NewContact)[] = [
  "fullName",
  "firstName",
  "lastName",
  "company",
  "title",
  "emails",
  "phoneNumbers",
  "linkedinUrl",
  "location",
  "linkedinConnectedOn",
  "lastLinkedinMessageDate",
  "firstInteractionDate",
  "lastInteractionDate",
  "interactionSources",
  "meshId",
  "meshUrl",
];

function differs(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? []) !== JSON.stringify(b ?? []);
  }
  return (a ?? null) !== (b ?? null);
}

export async function importCsvText(
  text: string,
  filename: string,
): Promise<ImportSummary> {
  const empty: ImportSummary = {
    ok: false,
    rowCount: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    notesCreated: 0,
    groupsCreated: [],
  };

  const parsed = Papa.parse<CsvRow>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  if (parsed.errors.length > 3) {
    return {
      ...empty,
      error: `CSV parse failed: ${parsed.errors[0].message} (row ${parsed.errors[0].row})`,
    };
  }
  const rows = parsed.data;
  const headers = Object.keys(rows[0] ?? {});
  const missing = EXPECTED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length) {
    return {
      ...empty,
      error: `This doesn't look like combined_contacts.csv — missing columns: ${missing.join(", ")}`,
    };
  }

  const db = getDb();
  const mapped = rows.map(mapRow);

  // --- Ensure groups exist ---
  const wantedGroups = [...new Set(mapped.flatMap((m) => m.groupNames))];
  const existingGroups = await db.select().from(groups);
  const groupByName = new Map(existingGroups.map((g) => [g.name.toLowerCase(), g]));
  const groupsCreated: string[] = [];
  for (const name of wantedGroups) {
    if (!groupByName.has(name.toLowerCase())) {
      const color =
        GROUP_COLORS[(existingGroups.length + groupsCreated.length) % GROUP_COLORS.length];
      const [g] = await db
        .insert(groups)
        .values({ name, color })
        .onConflictDoNothing()
        .returning();
      if (g) {
        groupByName.set(name.toLowerCase(), g);
        groupsCreated.push(name);
      }
    }
  }

  // --- Match against existing contacts ---
  const existing = await db.select().from(contacts);
  const byLinkedin = new Map<string, (typeof existing)[number]>();
  const byMeshId = new Map<string, (typeof existing)[number]>();
  const byName = new Map<string, (typeof existing)[number] | "dup">();
  for (const c of existing) {
    if (c.linkedinUrl) byLinkedin.set(c.linkedinUrl, c);
    if (c.meshId) byMeshId.set(c.meshId, c);
    const key = c.fullName.trim().toLowerCase();
    byName.set(key, byName.has(key) ? "dup" : c);
  }

  const toInsert: { values: NewContact; groupNames: string[]; noteBody: string | null }[] = [];
  const toUpdate: {
    id: number;
    patch: Partial<NewContact>;
    groupNames: string[];
    noteBody: string | null;
  }[] = [];
  let skipped = 0;
  const seenKeys = new Set<string>();

  for (const m of mapped) {
    // Skip duplicate rows within the file itself
    const fileKey =
      m.values.linkedinUrl ?? m.values.meshId ?? m.values.fullName.toLowerCase();
    if (seenKeys.has(fileKey)) {
      skipped++;
      continue;
    }
    seenKeys.add(fileKey);

    let match =
      (m.values.linkedinUrl && byLinkedin.get(m.values.linkedinUrl)) ||
      (m.values.meshId && byMeshId.get(m.values.meshId)) ||
      undefined;
    if (!match) {
      const nameHit = byName.get(m.values.fullName.trim().toLowerCase());
      if (nameHit && nameHit !== "dup") match = nameHit;
    }

    if (!match) {
      toInsert.push(m);
      continue;
    }

    const patch: Partial<NewContact> = {};
    for (const key of COMPARE_KEYS) {
      const incoming = m.values[key];
      // Import never blanks out data the user may have edited by hand
      if (incoming == null || (Array.isArray(incoming) && incoming.length === 0)) continue;
      if (differs(incoming, match[key as keyof typeof match])) {
        (patch as Record<string, unknown>)[key] = incoming;
      }
    }
    // Birthday and starred only ever flow in, never overwrite non-empty values
    if (m.values.birthday && !match.birthday) patch.birthday = m.values.birthday;
    if (m.values.starred && !match.starred) patch.starred = true;

    if (Object.keys(patch).length > 0) {
      toUpdate.push({ id: match.id, patch, groupNames: m.groupNames, noteBody: m.noteBody });
    } else {
      skipped++;
      // Still sync groups/notes below for unchanged rows
      toUpdate.push({ id: match.id, patch: {}, groupNames: m.groupNames, noteBody: m.noteBody });
    }
  }

  // --- Insert new contacts in chunks ---
  const insertedIds: { id: number; groupNames: string[]; noteBody: string | null }[] = [];
  const CHUNK = 200;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const returned = await db
      .insert(contacts)
      .values(chunk.map((c) => c.values))
      .returning({ id: contacts.id });
    returned.forEach((r, j) => {
      insertedIds.push({
        id: r.id,
        groupNames: chunk[j].groupNames,
        noteBody: chunk[j].noteBody,
      });
    });
  }

  // --- Apply updates (only rows with real changes) ---
  let updatedCount = 0;
  for (const u of toUpdate) {
    if (Object.keys(u.patch).length === 0) continue;
    await db
      .update(contacts)
      .set({ ...u.patch, updatedAt: new Date() })
      .where(eq(contacts.id, u.id));
    updatedCount++;
  }

  // --- Sync group memberships (additive) ---
  const linkRows: { contactId: number; groupId: number }[] = [];
  const allTargets = [
    ...insertedIds,
    ...toUpdate.map((u) => ({ id: u.id, groupNames: u.groupNames, noteBody: u.noteBody })),
  ];
  for (const t of allTargets) {
    for (const name of t.groupNames) {
      const g = groupByName.get(name.toLowerCase());
      if (g) linkRows.push({ contactId: t.id, groupId: g.id });
    }
  }
  for (let i = 0; i < linkRows.length; i += CHUNK) {
    await db
      .insert(contactGroups)
      .values(linkRows.slice(i, i + CHUNK))
      .onConflictDoNothing();
  }

  // --- Import notes (once per contact, marked as imported) ---
  const noteTargets = allTargets.filter((t) => t.noteBody);
  let notesCreated = 0;
  if (noteTargets.length) {
    const withImported = await db
      .select({ contactId: notes.contactId })
      .from(notes)
      .where(
        and(
          eq(notes.source, "imported"),
          inArray(
            notes.contactId,
            noteTargets.map((t) => t.id),
          ),
        ),
      );
    const already = new Set(
      withImported.map((n) => n.contactId),
    );
    const newNotes = noteTargets
      .filter((t) => !already.has(t.id))
      .map((t) => ({
        contactId: t.id,
        body: t.noteBody!,
        source: "imported" as const,
      }));
    if (newNotes.length) {
      await db.insert(notes).values(newNotes);
      notesCreated = newNotes.length;
    }
  }

  await db.insert(imports).values({
    filename,
    rowCount: rows.length,
    createdCount: insertedIds.length,
    updatedCount,
    skippedCount: skipped,
    notesCreated,
  });

  return {
    ok: true,
    rowCount: rows.length,
    created: insertedIds.length,
    updated: updatedCount,
    skipped,
    notesCreated,
    groupsCreated,
  };
}
