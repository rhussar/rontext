/**
 * The filter vocabulary behind the MCP `list_filter_values` tool.
 *
 * An agent cannot filter by group, school, or city until it knows this book
 * *has* a group called "Gold" and that the cohorts are colors. Without this
 * tool the only way to learn that is to guess, and a wrong guess costs a
 * round trip and returns nothing — which reads to the agent as "no such
 * person" rather than "no such group".
 *
 * Every count here is produced by the *same* predicate `search_contacts`
 * applies, not by a group-by over the raw column. That distinction is the
 * point: "Syracuse University" stores 35 education rows, but a substring
 * filter also catches "Syracuse University - Martin J. Whitman School of
 * Management", so the honest answer to "how many will I get" is 60. A facet
 * list whose counts disagree with the filter it advertises is worse than no
 * facet list.
 */

import { sql } from "drizzle-orm";
import { getDb } from "@/db";

/**
 * Turn a candidate value into a containment pattern, wildcards escaped.
 *
 * Values here come from the database, not a caller, so this is not an
 * injection guard — it keeps the count *faithful*: `search_contacts` escapes
 * the term it is handed, and a facet count computed with an unescaped `_`
 * would quietly exceed what the advertised filter actually returns.
 */
const BS = sql`chr(92)`; // backslash, spelled out — a literal one reads differently under standard_conforming_strings
const LIKE_PATTERN = sql`'%' || replace(replace(replace(value, ${BS}, ${BS} || ${BS}), '%', ${BS} || '%'), '_', ${BS} || '_') || '%'`;

export type Facet = {
  value: string;
  /** Active contacts `search_contacts` returns for this exact value. */
  count: number;
};

export type ContactFacets = {
  groups: Facet[];
  schools: Facet[];
  locations: Facet[];
  companies: Facet[];
  totals: {
    contacts: number;
    archived: number;
    withNotes: number;
    withUnsentDrafts: number;
    openReminders: number;
  };
};

export async function listContactFacets(limit = 25): Promise<ContactFacets> {
  const db = getDb();
  const cap = Math.min(Math.max(limit, 1), 100);

  // Four statements rather than one UNION ALL with a CASE per kind: over
  // neon-http these fly concurrently, so it costs one round trip of latency
  // and stays readable.
  const [groupRows, schoolRows, placeRows, companyRows, totalRows] = await Promise.all([
    db.execute<{ value: string; count: number }>(sql`
      select gr.name as value,
             count(*) filter (where c.archived_at is null)::int as count
      from groups gr
        left join contact_groups cg on cg.group_id = gr.id
        left join contacts c on c.id = cg.contact_id
      group by gr.name
      order by count desc, gr.name
      limit ${cap}
    `),
    // Candidates come from contact_education (410 rows, where most schooling
    // actually lives); the count then applies the full search predicate, so a
    // parent school's number includes its own sub-school strings.
    db.execute<{ value: string; count: number }>(sql`
      with top as (
        select school as value, count(distinct contact_id) n
        from contact_education group by school order by n desc limit ${cap}
      ), cand as (select value, ${LIKE_PATTERN} as pat from top)
      select cand.value, (
        select count(*)::int from contacts c
        where c.archived_at is null and exists (
          select 1 from contact_education ed
          where ed.contact_id = c.id and ed.school ilike cand.pat
        )
      ) as count
      from cand order by count desc, value
    `),
    // Places come from the graph's rolled-up entities because those names are
    // already clean ("Chicago"); the raw column is three spellings deep.
    db.execute<{ value: string; count: number }>(sql`
      with top as (
        select name as value from entities where type = 'place'
        order by member_count desc limit ${cap}
      ), cand as (select value, ${LIKE_PATTERN} as pat from top)
      select cand.value, (
        select count(*)::int from contacts c
        where c.archived_at is null and (
          c.location ilike cand.pat
          or exists (
            select 1 from contact_entities ce
              join entities e on e.id = ce.entity_id
              left join entities p on p.id = e.parent_id
            where ce.contact_id = c.id and e.type = 'place'
              and (e.name ilike cand.pat or p.name ilike cand.pat)
          )
        )
      ) as count
      from cand order by count desc, value
    `),
    db.execute<{ value: string; count: number }>(sql`
      with top as (
        select name as value from entities where type = 'company' and member_count > 1
        order by member_count desc limit ${cap}
      ), cand as (select value, ${LIKE_PATTERN} as pat from top)
      select cand.value, (
        select count(*)::int from contacts c
        where c.archived_at is null and (
          c.company ilike cand.pat
          or exists (
            select 1 from contact_entities ce
              join entities e on e.id = ce.entity_id
              left join entities p on p.id = e.parent_id
            where ce.contact_id = c.id and e.type = 'company'
              and (e.name ilike cand.pat or p.name ilike cand.pat)
          )
        )
      ) as count
      from cand order by count desc, value
    `),
    db.execute<{
      contacts: number;
      archived: number;
      with_notes: number;
      with_unsent_drafts: number;
      open_reminders: number;
    }>(sql`
      select
        (select count(*)::int from contacts where archived_at is null) as contacts,
        (select count(*)::int from contacts where archived_at is not null) as archived,
        (select count(distinct contact_id)::int from notes) as with_notes,
        (select count(distinct contact_id)::int from drafts where sent_at is null)
          as with_unsent_drafts,
        (select count(*)::int from reminders where completed_at is null) as open_reminders
    `),
  ]);

  const t = totalRows.rows[0];
  return {
    groups: groupRows.rows,
    schools: schoolRows.rows,
    locations: placeRows.rows,
    companies: companyRows.rows,
    totals: {
      contacts: t?.contacts ?? 0,
      archived: t?.archived ?? 0,
      withNotes: t?.with_notes ?? 0,
      withUnsentDrafts: t?.with_unsent_drafts ?? 0,
      openReminders: t?.open_reminders ?? 0,
    },
  };
}
