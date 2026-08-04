"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  contactChanges,
  contactEntities,
  contactGroups,
  contactPhotos,
  contacts,
  dismissedDuplicates,
  notes,
  reminders,
} from "@/db/schema";
import {
  findDuplicates,
  type DupCandidate,
  type DupPair,
} from "@/lib/duplicates";
import { nameFromEmail } from "@/lib/cleanup";

function revalidateAll() {
  revalidatePath("/", "layout");
}

export async function listDuplicatePairs(): Promise<DupPair[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      company: contacts.company,
      title: contacts.title,
      linkedinUrl: contacts.linkedinUrl,
      emails: contacts.emails,
      phoneNumbers: contacts.phoneNumbers,
      location: contacts.location,
      createdAt: contacts.createdAt,
    })
    .from(contacts)
    .where(and(isNull(contacts.archivedAt), isNull(contacts.mergedIntoId)));

  const noteRows = await db
    .select({ contactId: notes.contactId })
    .from(notes);
  const photoRows = await db
    .select({ contactId: contactPhotos.contactId })
    .from(contactPhotos);
  const dismissedRows = await db.select().from(dismissedDuplicates);

  const noteCounts = new Map<number, number>();
  for (const n of noteRows)
    noteCounts.set(n.contactId, (noteCounts.get(n.contactId) ?? 0) + 1);
  const photoed = new Set(photoRows.map((p) => p.contactId));
  const dismissed = new Set(
    dismissedRows.map((d) => `${d.contactIdA}-${d.contactIdB}`),
  );

  const candidates: DupCandidate[] = rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    noteCount: noteCounts.get(r.id) ?? 0,
    hasPhoto: photoed.has(r.id),
  }));

  return findDuplicates(candidates, dismissed);
}

export async function dismissDuplicate(idA: number, idB: number) {
  const [a, b] = idA < idB ? [idA, idB] : [idB, idA];
  await getDb()
    .insert(dismissedDuplicates)
    .values({ contactIdA: a, contactIdB: b })
    .onConflictDoNothing();
  revalidateAll();
}

const firstNonEmpty = <T,>(...vals: (T | null | undefined)[]): T | null => {
  for (const v of vals) {
    if (v !== null && v !== undefined && String(v).trim() !== "") return v;
  }
  return null;
};

const unionList = (a: string[], b: string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of [...a, ...b]) {
    const k = v.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v.trim());
  }
  return out;
};

const earlier = (a: string | null, b: string | null) =>
  !a ? b : !b ? a : a < b ? a : b;
const later = (a: string | null, b: string | null) =>
  !a ? b : !b ? a : a > b ? a : b;

/**
 * Fold `loserId` into `keeperId`. Everything the loser holds that the keeper
 * lacks moves across, then the loser is archived rather than deleted so the
 * merge stays reversible.
 */
export async function mergeContacts(keeperId: number, loserId: number) {
  if (keeperId === loserId) return;
  const db = getDb();

  const [keeper] = await db.select().from(contacts).where(eq(contacts.id, keeperId));
  const [loser] = await db.select().from(contacts).where(eq(contacts.id, loserId));
  if (!keeper || !loser) return;

  // Release the loser's unique values first — linkedin_url and mesh_id both
  // carry unique indexes, so the keeper can't take them while the loser holds them.
  await db
    .update(contacts)
    .set({ linkedinUrl: null, meshId: null })
    .where(eq(contacts.id, loserId));

  await db
    .update(contacts)
    .set({
      firstName: firstNonEmpty(keeper.firstName, loser.firstName),
      lastName: firstNonEmpty(keeper.lastName, loser.lastName),
      company: firstNonEmpty(keeper.company, loser.company),
      title: firstNonEmpty(keeper.title, loser.title),
      headline: firstNonEmpty(keeper.headline, loser.headline),
      emails: unionList(keeper.emails, loser.emails),
      phoneNumbers: unionList(keeper.phoneNumbers, loser.phoneNumbers),
      linkedinUrl: firstNonEmpty(keeper.linkedinUrl, loser.linkedinUrl),
      meshId: firstNonEmpty(keeper.meshId, loser.meshId),
      meshUrl: firstNonEmpty(keeper.meshUrl, loser.meshUrl),
      birthday: firstNonEmpty(keeper.birthday, loser.birthday),
      location: firstNonEmpty(keeper.location, loser.location),
      starred: keeper.starred || loser.starred,
      interactionSources: unionList(
        keeper.interactionSources,
        loser.interactionSources,
      ),
      firstInteractionDate: earlier(
        keeper.firstInteractionDate,
        loser.firstInteractionDate,
      ),
      lastInteractionDate: later(
        keeper.lastInteractionDate,
        loser.lastInteractionDate,
      ),
      linkedinConnectedOn: earlier(
        keeper.linkedinConnectedOn,
        loser.linkedinConnectedOn,
      ),
      lastLinkedinMessageDate: later(
        keeper.lastLinkedinMessageDate,
        loser.lastLinkedinMessageDate,
      ),
      // Location may now come from the loser, so let the map re-resolve.
      ...(keeper.location
        ? {}
        : { latitude: null, longitude: null, geocodedAt: null }),
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, keeperId));

  // Plain FK children can just be repointed.
  await db.update(notes).set({ contactId: keeperId }).where(eq(notes.contactId, loserId));
  await db
    .update(reminders)
    .set({ contactId: keeperId })
    .where(eq(reminders.contactId, loserId));
  await db
    .update(contactChanges)
    .set({ contactId: keeperId })
    .where(eq(contactChanges.contactId, loserId));

  // These two have composite primary keys, so repointing would throw whenever
  // both records share a group or entity. Copy with conflicts ignored, then drop.
  const loserGroups = await db
    .select({ groupId: contactGroups.groupId })
    .from(contactGroups)
    .where(eq(contactGroups.contactId, loserId));
  if (loserGroups.length) {
    await db
      .insert(contactGroups)
      .values(loserGroups.map((g) => ({ contactId: keeperId, groupId: g.groupId })))
      .onConflictDoNothing();
    await db.delete(contactGroups).where(eq(contactGroups.contactId, loserId));
  }

  const loserEntities = await db
    .select()
    .from(contactEntities)
    .where(eq(contactEntities.contactId, loserId));
  if (loserEntities.length) {
    await db
      .insert(contactEntities)
      .values(loserEntities.map((e) => ({ ...e, contactId: keeperId })))
      .onConflictDoNothing();
    await db.delete(contactEntities).where(eq(contactEntities.contactId, loserId));
  }

  const [keeperPhoto] = await db
    .select({ contactId: contactPhotos.contactId })
    .from(contactPhotos)
    .where(eq(contactPhotos.contactId, keeperId));
  if (!keeperPhoto) {
    await db
      .update(contactPhotos)
      .set({ contactId: keeperId })
      .where(eq(contactPhotos.contactId, loserId));
  }

  await db
    .update(contacts)
    .set({
      mergedIntoId: keeperId,
      archivedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, loserId));

  revalidateAll();
}

export async function unmergeContact(loserId: number) {
  await getDb()
    .update(contacts)
    .set({ mergedIntoId: null, archivedAt: null, updatedAt: new Date() })
    .where(eq(contacts.id, loserId));
  revalidateAll();
}

// ---------- Cleanup queue ----------

export type CleanupItem = {
  id: number;
  fullName: string;
  kind: "email-name" | "phone-name";
  suggestion: string | null;
  company: string | null;
  emails: string[];
  phoneNumbers: string[];
};

export async function listCleanupItems(): Promise<CleanupItem[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      company: contacts.company,
      emails: contacts.emails,
      phoneNumbers: contacts.phoneNumbers,
    })
    .from(contacts)
    .where(
      and(
        isNull(contacts.archivedAt),
        sql`(${contacts.fullName} LIKE '%@%' OR ${contacts.fullName} ~ '^[+0-9][0-9 ()+-]*$')`,
      ),
    );

  return rows.map((r) => {
    const isEmail = r.fullName.includes("@");
    return {
      ...r,
      kind: isEmail ? ("email-name" as const) : ("phone-name" as const),
      suggestion: isEmail ? nameFromEmail(r.fullName) : null,
    };
  });
}

export async function applyCleanupName(id: number, fullName: string) {
  const trimmed = fullName.trim();
  if (!trimmed) return;
  const parts = trimmed.split(/\s+/);
  await getDb()
    .update(contacts)
    .set({
      fullName: trimmed,
      firstName: parts[0],
      lastName: parts.length > 1 ? parts[parts.length - 1] : null,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, id));
  revalidateAll();
}
