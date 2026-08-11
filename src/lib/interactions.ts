import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interactions, type InteractionSource } from "@/db/schema";

export type InteractionInput = {
  contactId: number;
  source: InteractionSource;
  /** "YYYY-MM-DD" */
  firstAt: string | null;
  lastAt: string | null;
  messageCount: number;
  sentCount: number;
  receivedCount: number;
};

/**
 * Collapse rows that share a contact and source.
 *
 * One person can reach you on several handles — a phone number *and* an Apple
 * ID email both resolving to the same contact — and Postgres rejects an
 * `ON CONFLICT` statement that touches the same key twice ("cannot affect row a
 * second time"). Counts sum here because these really are separate
 * conversations with one person; the per-run total stays stable, so the
 * `greatest()` merge below is still idempotent across runs.
 */
function coalesceByContact(rows: InteractionInput[]): InteractionInput[] {
  const out = new Map<string, InteractionInput>();
  for (const r of rows) {
    const key = `${r.contactId}:${r.source}`;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { ...r });
      continue;
    }
    prev.messageCount += r.messageCount;
    prev.sentCount += r.sentCount;
    prev.receivedCount += r.receivedCount;
    if (r.firstAt && (!prev.firstAt || r.firstAt < prev.firstAt)) prev.firstAt = r.firstAt;
    if (r.lastAt && (!prev.lastAt || r.lastAt > prev.lastAt)) prev.lastAt = r.lastAt;
  }
  return [...out.values()];
}

/**
 * Merge aggregate interaction rows, one per contact per source.
 *
 * Counts take the *larger* of old and new rather than summing: a connector
 * recomputes totals over its whole window on every run, so summing would
 * double them on a re-sync. Taking the max means re-running the same window is
 * a no-op and widening the window still grows the number.
 *
 * Written as a single multi-row upsert — over Neon's HTTP driver a per-row
 * round trip is the thing that makes a bulk sync slow.
 */
export async function upsertInteractions(rows: InteractionInput[]): Promise<void> {
  const merged = coalesceByContact(rows);
  if (!merged.length) return;
  const now = new Date();
  await getDb()
    .insert(interactions)
    .values(merged.map((r) => ({ ...r, updatedAt: now })))
    .onConflictDoUpdate({
      target: [interactions.contactId, interactions.source],
      set: {
        // LEAST/GREATEST ignore NULLs in Postgres, so a row with no date yet
        // simply adopts the incoming one.
        firstAt: sql`least(${interactions.firstAt}, excluded.first_at)`,
        lastAt: sql`greatest(${interactions.lastAt}, excluded.last_at)`,
        messageCount: sql`greatest(${interactions.messageCount}, excluded.message_count)`,
        sentCount: sql`greatest(${interactions.sentCount}, excluded.sent_count)`,
        receivedCount: sql`greatest(${interactions.receivedCount}, excluded.received_count)`,
        updatedAt: now,
      },
    });
}

/**
 * Fold `interactions` up into the denormalized columns on `contacts` that the
 * UI already reads — firstInteractionDate, lastInteractionDate and
 * interactionSources drive Home's "Haven't talked in a while",
 * reachOutSentence(), graph tie-strength and the person timeline.
 *
 * Widening only. A connector with a 12-month window must never erase a 2014
 * first-interaction date that came in with the CSV seed, so this takes
 * LEAST/GREATEST against what's already there and unions the source list.
 *
 * One set-based statement over every contact with interaction rows — cheaper
 * than per-contact updates and safe to run after any sync. The WHERE clause
 * skips rows that wouldn't change, keeping updatedAt meaningful.
 */
export async function rollupInteractions(): Promise<number> {
  const db = getDb();

  // Snapshot the pre-connector values first, once per contact, so a revert can
  // put them back. ON CONFLICT DO NOTHING means the *original* baseline
  // survives every later sync — this row is written once and never updated.
  await db.execute(sql`
    insert into contact_rollup_baseline
      (contact_id, first_interaction_date, last_interaction_date, interaction_sources)
    select c.id, c.first_interaction_date, c.last_interaction_date, c.interaction_sources
    from contacts c
    join (select contact_id from interactions group by contact_id) i on c.id = i.contact_id
    on conflict (contact_id) do nothing
  `);

  const res = await db.execute(sql`
    update contacts c set
      first_interaction_date = least(c.first_interaction_date, i.min_first),
      last_interaction_date  = greatest(c.last_interaction_date, i.max_last),
      interaction_sources = (
        select coalesce(array_agg(distinct s order by s), '{}')
        from unnest(c.interaction_sources || i.sources) s
        where s <> ''
      ),
      updated_at = now()
    from (
      select contact_id,
             min(first_at) as min_first,
             max(last_at)  as max_last,
             array_agg(distinct source::text) as sources
      from interactions
      group by contact_id
    ) i
    where c.id = i.contact_id
      and (
        c.first_interaction_date is distinct from least(c.first_interaction_date, i.min_first)
        or c.last_interaction_date is distinct from greatest(c.last_interaction_date, i.max_last)
        or not (c.interaction_sources @> i.sources)
      )
  `);
  return res.rowCount ?? 0;
}
