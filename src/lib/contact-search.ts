/**
 * The filtered contact query behind the MCP `search_contacts` tool.
 *
 * Lives in a plain module (not "use server") so the route, scripts, and any
 * future UI can all import it — same reason `graph/query.ts` does.
 *
 * Why raw SQL instead of the drizzle builder: nearly every filter here is an
 * OR across a scalar column *and* an EXISTS over a join table (school matches
 * either `contact_education.school` or a rolled-up `entities` row), and the
 * result rows carry four correlated aggregates. Expressed through the builder
 * that becomes unreadable; expressed as one statement it is also **one** neon
 * round trip for the whole page of results, aggregates and total included.
 *
 * Two facts about this data shape the design, both learned from the rows:
 *
 *  - Location strings are not canonical. The same city appears as "Chicago,
 *    Illinois, United States", "Chicago Illinois United States", and "Greater
 *    Chicago Area United States". So every text filter is a substring match,
 *    never equality, and location additionally consults the `place` entities
 *    (and their parents) that the graph rollup already normalized.
 *  - Coverage is partial and uneven — 428 of 2,105 active contacts have a
 *    location at all, 189 have a place entity. A filter that only trusted the
 *    entity link would silently lose two thirds of the people it should find,
 *    which is why both sides of every OR are kept.
 */

import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";

export const SEARCH_SORTS = ["best", "name", "recent", "stale"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export type ContactSearchFilters = {
  /** Free text across name, company, title, headline, location, hometown, email. */
  query?: string;
  /** Group names. ALL must match — the narrowing case ("Yale" AND "Red"). */
  groups?: string[];
  location?: string;
  hometown?: string;
  school?: string;
  company?: string;
  /** Matched against job title and LinkedIn headline. */
  title?: string;
  /** Substring of any note body; matching rows come back with a snippet. */
  notesContain?: string;
  starred?: boolean;
  hasNotes?: boolean;
  /** ISO date. Excludes never-contacted people — a null date is not "before". */
  lastInteractionBefore?: string;
  lastInteractionAfter?: string;
  includeArchived?: boolean;
  sort?: SearchSort;
  limit?: number;
  offset?: number;
};

export type ContactSearchRow = {
  id: number;
  fullName: string;
  company: string | null;
  title: string | null;
  headline: string | null;
  location: string | null;
  hometown: string | null;
  starred: boolean;
  archived: boolean;
  lastInteractionDate: string | null;
  groups: string[];
  schools: string[];
  noteCount: number;
  unsentDraftCount: number;
  openReminderCount: number;
  /** Text around the `notesContain` hit; null unless that filter was used. */
  noteMatch: string | null;
};

export type ContactSearchResult = {
  /** Matches before limit/offset — tells a caller whether to narrow or page. */
  total: number;
  offset: number;
  rows: ContactSearchRow[];
};

/**
 * Wrap a user string as a LIKE containment pattern.
 *
 * The escape matters: a search for "50%" or "a_b" would otherwise turn the
 * user's literal into a wildcard and quietly over-match. Backslash is
 * Postgres's default LIKE escape, so escaping it plus the two wildcards is the
 * whole job.
 */
function contains(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

/** `entities` match for one type, following the parent rollup (Whitman -> Syracuse). */
function entityMatch(type: "place" | "school" | "company", term: string): SQL {
  const pattern = contains(term);
  return sql`exists (
    select 1 from contact_entities ce
      join entities e on e.id = ce.entity_id
      left join entities p on p.id = e.parent_id
    where ce.contact_id = c.id
      and e.type = ${type}
      and (e.name ilike ${pattern} or p.name ilike ${pattern})
  )`;
}

export async function searchContacts(
  f: ContactSearchFilters,
): Promise<ContactSearchResult> {
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 100);
  const offset = Math.max(f.offset ?? 0, 0);
  const where: SQL[] = [];

  if (!f.includeArchived) where.push(sql`c.archived_at is null`);

  if (f.query) {
    const q = contains(f.query);
    where.push(sql`(
      c.full_name ilike ${q}
      or c.company ilike ${q}
      or c.title ilike ${q}
      or c.headline ilike ${q}
      or c.location ilike ${q}
      or c.hometown ilike ${q}
      or exists (select 1 from unnest(c.emails) em where em ilike ${q})
    )`);
  }

  // One EXISTS per name rather than an IN over all of them: `in` would mean
  // "any of these groups", and the useful question is the intersection.
  for (const name of f.groups ?? []) {
    const g = contains(name);
    where.push(sql`exists (
      select 1 from contact_groups cg join groups gr on gr.id = cg.group_id
      where cg.contact_id = c.id and gr.name ilike ${g}
    )`);
  }

  if (f.location) {
    where.push(
      sql`(c.location ilike ${contains(f.location)} or ${entityMatch("place", f.location)})`,
    );
  }
  if (f.hometown) where.push(sql`c.hometown ilike ${contains(f.hometown)}`);

  if (f.school) {
    const s = contains(f.school);
    where.push(sql`(
      exists (
        select 1 from contact_education ed
        where ed.contact_id = c.id and (ed.school ilike ${s} or ed.degree ilike ${s})
      )
      or ${entityMatch("school", f.school)}
    )`);
  }

  if (f.company) {
    where.push(
      sql`(c.company ilike ${contains(f.company)} or ${entityMatch("company", f.company)})`,
    );
  }

  if (f.title) {
    const t = contains(f.title);
    where.push(sql`(c.title ilike ${t} or c.headline ilike ${t})`);
  }

  if (f.notesContain) {
    where.push(sql`exists (
      select 1 from notes n where n.contact_id = c.id and n.body ilike ${contains(f.notesContain)}
    )`);
  }

  if (f.starred !== undefined) where.push(sql`c.starred = ${f.starred}`);
  if (f.hasNotes !== undefined) {
    const has = sql`exists (select 1 from notes n where n.contact_id = c.id)`;
    where.push(f.hasNotes ? has : sql`not ${has}`);
  }
  if (f.lastInteractionBefore) {
    where.push(sql`c.last_interaction_date < ${f.lastInteractionBefore}::date`);
  }
  if (f.lastInteractionAfter) {
    where.push(sql`c.last_interaction_date > ${f.lastInteractionAfter}::date`);
  }

  const whereSql = where.length
    ? sql`where ${sql.join(where, sql` and `)}`
    : sql`where true`;

  // "best" leads with how well the *name* matched, because a person search is
  // overwhelmingly a name search — "Sarah" should not rank a company called
  // "Sarah Lawrence" above the Sarah you know. Every sort then falls back to
  // people you've actually talked to, then alphabetical, so the order is
  // stable across pages.
  const sort = f.sort ?? "best";
  // Patterns are built whole in JS: `${param}%` inside a sql template would
  // emit `$1%`, which Postgres reads as the modulo operator, not a wildcard.
  const escaped = f.query ? f.query.replace(/[\\%_]/g, "\\$&") : "";
  const nameRank =
    sort === "best" && f.query
      ? sql`case
          when c.full_name ilike ${escaped} then 0
          when c.full_name ilike ${escaped + "%"} then 1
          when c.full_name ilike ${contains(f.query)} then 2
          else 3 end, `
      : sql``;
  const orderSql =
    sort === "name"
      ? sql`order by c.full_name asc`
      : sort === "recent"
        ? sql`order by c.last_interaction_date desc nulls last, c.full_name asc`
        : sort === "stale"
          ? sql`order by c.last_interaction_date asc nulls last, c.full_name asc`
          : sql`order by ${nameRank}(c.last_interaction_date is not null) desc, c.full_name asc`;

  // Snippet, not the whole note: enough context to recognize the hit without
  // pouring a 10k-character note into the caller's context window.
  const noteMatch = f.notesContain
    ? sql`(
        select substring(
          n.body from greatest(1, position(lower(${f.notesContain}) in lower(n.body)) - 60) for 220
        )
        from notes n
        where n.contact_id = c.id and n.body ilike ${contains(f.notesContain)}
        order by n.created_at desc
        limit 1
      )`
    : sql`null::text`;

  const rows = await getDb().execute<{
    id: number;
    full_name: string;
    company: string | null;
    title: string | null;
    headline: string | null;
    location: string | null;
    hometown: string | null;
    starred: boolean;
    archived: boolean;
    last_interaction_date: string | null;
    group_names: string[];
    schools: string[];
    note_count: number;
    unsent_draft_count: number;
    open_reminder_count: number;
    note_match: string | null;
    total: number;
  }>(sql`
    select
      c.id,
      c.full_name,
      c.company,
      c.title,
      c.headline,
      c.location,
      c.hometown,
      c.starred,
      (c.archived_at is not null) as archived,
      c.last_interaction_date,
      coalesce((
        select array_agg(gr.name order by gr.name)
        from contact_groups cg join groups gr on gr.id = cg.group_id
        where cg.contact_id = c.id
      ), '{}') as group_names,
      -- Both sources, unioned: a school filter matches typed education rows AND
      -- the graph's school-entity links, so a row showing only the first would
      -- look like an unexplained hit. Every match has to be visible in the row
      -- that carries it, or a caller cannot tell a good result from a bug.
      coalesce((
        select array_agg(distinct sch) from (
          select ed.school as sch from contact_education ed where ed.contact_id = c.id
          union
          select e.name from contact_entities ce join entities e on e.id = ce.entity_id
          where ce.contact_id = c.id and e.type = 'school'
        ) x
      ), '{}') as schools,
      (select count(*)::int from notes n where n.contact_id = c.id) as note_count,
      (select count(*)::int from drafts d where d.contact_id = c.id and d.sent_at is null)
        as unsent_draft_count,
      (select count(*)::int from reminders r where r.contact_id = c.id and r.completed_at is null)
        as open_reminder_count,
      ${noteMatch} as note_match,
      (count(*) over ())::int as total
    from contacts c
    ${whereSql}
    ${orderSql}
    limit ${limit} offset ${offset}
  `);

  return {
    total: rows.rows[0]?.total ?? 0,
    offset,
    rows: rows.rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      company: r.company,
      title: r.title,
      headline: r.headline,
      location: r.location,
      hometown: r.hometown,
      starred: r.starred,
      archived: r.archived,
      lastInteractionDate: r.last_interaction_date,
      groups: r.group_names ?? [],
      schools: r.schools ?? [],
      noteCount: r.note_count,
      unsentDraftCount: r.unsent_draft_count,
      openReminderCount: r.open_reminder_count,
      noteMatch: r.note_match,
    })),
  };
}
