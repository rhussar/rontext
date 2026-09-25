"use server";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  contactCandidates,
  contactChanges,
  contactDocs,
  contactEducation,
  contactEnrichment,
  contactEntities,
  contactGroups,
  contactPhotos,
  contactRollupBaseline,
  contacts,
  dismissedDuplicates,
  drafts,
  followUps,
  notes,
  reminders,
  threadSummaries,
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
    .where(isNull(contacts.archivedAt));

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
const laterTime = (a: Date | null, b: Date | null) =>
  !a ? b : !b ? a : a > b ? a : b;

/**
 * Fold `loserId` into `keeperId`, then delete the loser outright.
 *
 * The delete is deliberately the very last statement: neon-http has no
 * interactive transactions, so if any earlier step fails the loser is still
 * there and the merge can simply be retried. Anything still pointing at the
 * loser when it goes would be destroyed by ON DELETE CASCADE, so every child
 * table has to be moved above — see the audit comment before the delete.
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
      hometown: firstNonEmpty(keeper.hometown, loser.hometown),
      whatsappPhone: firstNonEmpty(keeper.whatsappPhone, loser.whatsappPhone),
      preferredChannel: keeper.preferredChannel ?? loser.preferredChannel,
      lastScrapedAt: laterTime(keeper.lastScrapedAt, loser.lastScrapedAt),
      lastViewedAt: laterTime(keeper.lastViewedAt, loser.lastViewedAt),
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
    .update(drafts)
    .set({ contactId: keeperId })
    .where(eq(drafts.contactId, loserId));
  await db
    .update(contactChanges)
    .set({ contactId: keeperId })
    .where(eq(contactChanges.contactId, loserId));
  await db
    .update(followUps)
    .set({ contactId: keeperId })
    .where(eq(followUps.contactId, loserId));

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

  // AI-derived fields keyed one-per-contact — keep the keeper's if it has one.
  const [keeperEnrichment] = await db
    .select({ contactId: contactEnrichment.contactId })
    .from(contactEnrichment)
    .where(eq(contactEnrichment.contactId, keeperId));
  if (keeperEnrichment) {
    await db
      .delete(contactEnrichment)
      .where(eq(contactEnrichment.contactId, loserId));
  } else {
    await db
      .update(contactEnrichment)
      .set({ contactId: keeperId })
      .where(eq(contactEnrichment.contactId, loserId));
  }

  await db
    .update(contactEducation)
    .set({ contactId: keeperId })
    .where(eq(contactEducation.contactId, loserId));
  await db
    .update(contactDocs)
    .set({ contactId: keeperId })
    .where(eq(contactDocs.contactId, loserId));
  // An accepted candidate remembers which contact it became; keep that true.
  await db
    .update(contactCandidates)
    .set({ contactId: keeperId })
    .where(eq(contactCandidates.contactId, loserId));

  // Interaction counts. Each email/phone is attributed to exactly one contact
  // (contactIdsByHandleKey), so the two records counted *different* messages
  // and the merged person's total is the sum. Each move is one statement —
  // delete-returning feeding the upsert — because neon-http has no
  // transactions: a retry after a crash must not add the same counts twice.
  await db.execute(sql`
    with moved as (
      delete from interactions where contact_id = ${loserId}
      returning source, first_at, last_at, message_count, sent_count, received_count
    )
    insert into interactions
      (contact_id, source, first_at, last_at, message_count, sent_count, received_count, updated_at)
    select ${keeperId}, source, first_at, last_at, message_count, sent_count, received_count, now()
    from moved
    on conflict (contact_id, source) do update set
      first_at = least(interactions.first_at, excluded.first_at),
      last_at = greatest(interactions.last_at, excluded.last_at),
      message_count = interactions.message_count + excluded.message_count,
      sent_count = interactions.sent_count + excluded.sent_count,
      received_count = interactions.received_count + excluded.received_count,
      updated_at = now()
  `);
  await db.execute(sql`
    with moved as (
      delete from interaction_periods where contact_id = ${loserId}
      returning source, month, message_count, sent_count, received_count
    )
    insert into interaction_periods
      (contact_id, source, month, message_count, sent_count, received_count, updated_at)
    select ${keeperId}, source, month, message_count, sent_count, received_count, now()
    from moved
    on conflict (contact_id, source, month) do update set
      message_count = interaction_periods.message_count + excluded.message_count,
      sent_count = interaction_periods.sent_count + excluded.sent_count,
      received_count = interaction_periods.received_count + excluded.received_count,
      updated_at = now()
  `);

  await db.execute(sql`
    with moved as (
      delete from meeting_contacts where contact_id = ${loserId} returning meeting_id
    )
    insert into meeting_contacts (meeting_id, contact_id)
    select meeting_id, ${keeperId} from moved
    on conflict do nothing
  `);

  // Observed "these two know each other" pairs. Re-key each of the loser's
  // pairs onto the keeper (lower id first, as the table requires) and drop the
  // loser↔keeper pair itself — that's one person now. Where the keeper already
  // has the pair, keep the larger evidence: the Mac reader replaces this
  // source wholesale on its next run anyway.
  await db.execute(sql`
    with moved as (
      delete from contact_links where contact_a = ${loserId} or contact_b = ${loserId}
      returning
        case when contact_a = ${loserId} then contact_b else contact_a end as other,
        source, threads, messages, last_at
    )
    insert into contact_links (contact_a, contact_b, source, threads, messages, last_at, updated_at)
    select least(${keeperId}::int, other), greatest(${keeperId}::int, other),
      source, threads, messages, last_at, now()
    from moved
    where other <> ${keeperId}
    on conflict (contact_a, contact_b, source) do update set
      threads = greatest(contact_links.threads, excluded.threads),
      messages = greatest(contact_links.messages, excluded.messages),
      last_at = greatest(contact_links.last_at, excluded.last_at),
      updated_at = now()
  `);

  // "A is not B" survives B being folded into K: A is not K either. Without
  // this the duplicates queue re-suggests pairs the owner already declined.
  await db.execute(sql`
    with moved as (
      delete from dismissed_duplicates
      where contact_id_a = ${loserId} or contact_id_b = ${loserId}
      returning case when contact_id_a = ${loserId} then contact_id_b else contact_id_a end as other
    )
    insert into dismissed_duplicates (contact_id_a, contact_id_b)
    select least(${keeperId}::int, other), greatest(${keeperId}::int, other)
    from moved
    where other <> ${keeperId}
    on conflict do nothing
  `);

  // Texts summaries: one per contact per source. Keep whichever covers the
  // more recent conversation.
  const summaries = await db
    .select({
      contactId: threadSummaries.contactId,
      source: threadSummaries.source,
      lastMessageAt: threadSummaries.lastMessageAt,
    })
    .from(threadSummaries)
    .where(inArray(threadSummaries.contactId, [keeperId, loserId]));
  for (const mine of summaries.filter((s) => s.contactId === loserId)) {
    const theirs = summaries.find((s) => s.contactId === keeperId && s.source === mine.source);
    if (theirs && theirs.lastMessageAt >= mine.lastMessageAt) {
      await db
        .delete(threadSummaries)
        .where(and(eq(threadSummaries.contactId, loserId), eq(threadSummaries.source, mine.source)));
      continue;
    }
    if (theirs) {
      await db
        .delete(threadSummaries)
        .where(and(eq(threadSummaries.contactId, keeperId), eq(threadSummaries.source, mine.source)));
    }
    await db
      .update(threadSummaries)
      .set({ contactId: keeperId })
      .where(and(eq(threadSummaries.contactId, loserId), eq(threadSummaries.source, mine.source)));
  }

  // The pre-connector snapshot revert-connector.ts restores from. Both halves
  // were the same person before any sync, so combine them the way the contact
  // row itself was combined above.
  const baselines = await db
    .select()
    .from(contactRollupBaseline)
    .where(inArray(contactRollupBaseline.contactId, [keeperId, loserId]));
  const keeperBase = baselines.find((b) => b.contactId === keeperId);
  const loserBase = baselines.find((b) => b.contactId === loserId);
  if (loserBase && keeperBase) {
    await db
      .update(contactRollupBaseline)
      .set({
        firstInteractionDate: earlier(keeperBase.firstInteractionDate, loserBase.firstInteractionDate),
        lastInteractionDate: later(keeperBase.lastInteractionDate, loserBase.lastInteractionDate),
        interactionSources: unionList(keeperBase.interactionSources, loserBase.interactionSources),
      })
      .where(eq(contactRollupBaseline.contactId, keeperId));
    await db.delete(contactRollupBaseline).where(eq(contactRollupBaseline.contactId, loserId));
  } else if (loserBase) {
    await db
      .update(contactRollupBaseline)
      .set({ contactId: keeperId })
      .where(eq(contactRollupBaseline.contactId, loserId));
  }

  // The search index is derived and rebuilt by the next memory sync, but until
  // then find_people would hand agents an id that no longer exists. Point the
  // loser's chunks at the keeper now; the sync drops what's redundant.
  await db.execute(sql`
    update memory_chunks
    set contact_ids = array(
      select distinct unnest(array_replace(contact_ids, ${loserId}::int, ${keeperId}::int))
    )
    where contact_ids @> array[${loserId}::int]
  `);

  // Every table referencing contacts.id has now been moved off the loser —
  // if you add one to the schema, move it here too, or ON DELETE CASCADE below
  // destroys it silently:
  //   notes, reminders, drafts, contact_changes, contact_groups,
  //   contact_entities, contact_photos, contact_enrichment, contact_education,
  //   contact_docs, contact_candidates, interactions, interaction_periods,
  //   meeting_contacts, contact_links, dismissed_duplicates, thread_summaries,
  //   contact_rollup_baseline (and memory_chunks, which has no FK).
  // Left to cascade: the loser's photo and enrichment when the keeper already
  // has its own (one per contact, keeper wins).
  await db.delete(contacts).where(eq(contacts.id, loserId));

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
