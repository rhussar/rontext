/**
 * Meaning-based people search — the query behind the MCP `find_people` tool.
 *
 * Hybrid retrieval over `memory_chunks`, in one SQL statement:
 *
 *  - vector leg: nearest chunks to the embedded query (skipped when no
 *    embedding key is configured — search degrades to keyword-only);
 *  - keyword leg: Postgres full-text over the same chunks, with the query's
 *    words OR-ed rather than AND-ed, so a long natural-language question
 *    still matches people who share only some of its terms;
 *  - reciprocal-rank fusion of the two, then rolled up from chunks to people.
 *
 * It returns candidates with evidence (the snippets that matched), not a
 * verdict. The caller is usually itself a model, which is better placed to
 * judge "is this person actually a fit" than any score here — so the job of
 * this module is recall and explainability, not a final ranking.
 *
 * Structured filters reuse contactFilterSql() from contact-search.ts, so
 * "group", "location" etc. mean exactly what they mean in search_contacts.
 */

import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { contactFilterSql, type ContactSearchFilters } from "@/lib/contact-search";
import { embed, embeddingKey, toVectorLiteral } from "@/lib/memory/embeddings";
import { memoryRefreshedAt, refreshMemory, type RefreshSummary } from "@/lib/memory/sync";

/** Candidates each leg contributes before fusion. */
const LEG_DEPTH = 300;
/** The standard RRF damping constant — rank 1 and rank 5 differ, rank 200 and 205 barely. */
const RRF_K = 60;
/**
 * Keyword matches count half as much as meaning matches in hybrid mode. The
 * keyword leg ORs every word of the question, so common verbs ("work",
 * "think", "help") match long transcripts all over; the vector leg is the
 * better judge of relevance and the keyword leg's job is to rescue exact
 * terms (names, acronyms) the embedding blurs. Keyword-only mode is unaffected.
 */
const KEYWORD_WEIGHT_HYBRID = 0.5;
/** Chunks beyond a person's best that still add to their score. */
const BONUS_CHUNKS = 2;
/** How many snippets each person carries back. */
const EVIDENCE_PER_PERSON = 2;

export type FindPeopleFilters = Pick<
  ContactSearchFilters,
  | "groups"
  | "location"
  | "school"
  | "company"
  | "starred"
  | "lastInteractionBefore"
  | "lastInteractionAfter"
  | "includeArchived"
>;

export type Evidence = { kind: "profile" | "note" | "meeting" | "conversation"; snippet: string };

export type FoundPerson = {
  id: number;
  fullName: string;
  headline: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  lastInteractionDate: string | null;
  /** Relative only — comparable within one result list, meaningless across queries. */
  score: number;
  /** How many of this person's chunks matched. */
  matches: number;
  evidence: Evidence[];
};

export type FindPeopleResult = {
  mode: "hybrid" | "keyword";
  /** Why the search ran keyword-only, when it did. */
  note?: string;
  people: FoundPerson[];
};

/**
 * Bring the index up to date if it's older than `maxAgeMs`. Cheap when fresh
 * (one app_state read); when stale, a diff plus embedding whatever changed,
 * bounded by `budgetMs`. Never throws — a stale index still answers, and a
 * read-only (demo) database can't be refreshed at all.
 */
export async function ensureFresh(
  maxAgeMs = 10 * 60_000,
  budgetMs = 12_000,
): Promise<RefreshSummary | null> {
  try {
    const at = await memoryRefreshedAt();
    if (at && Date.now() - at.getTime() < maxAgeMs) return null;
    return await refreshMemory(Date.now() + budgetMs);
  } catch {
    return null;
  }
}

async function embedQuery(query: string): Promise<{ vector: string | null; note?: string }> {
  const key = await embeddingKey();
  if (!key) {
    return {
      vector: null,
      note: "No VOYAGE_API_KEY configured, so matching is by words, not meaning. Try synonyms if results are thin.",
    };
  }
  try {
    const [v] = await embed(key, [query], "query", 8_000);
    return { vector: toVectorLiteral(v) };
  } catch (err) {
    return {
      vector: null,
      note: `Embedding failed (${err instanceof Error ? err.message : "unknown error"}), so matching fell back to words only.`,
    };
  }
}

export async function findPeople(
  query: string,
  filters: FindPeopleFilters,
  limit = 15,
): Promise<FindPeopleResult> {
  const { vector, note } = await embedQuery(query);

  const where = contactFilterSql(filters);
  // Anything beyond the archived default narrows the pool, and a narrow pool
  // must be searched *within*: taking the global top 300 by vector and then
  // filtering would silently drop the in-group people who ranked 301st.
  const narrowed = where.length > (filters.includeArchived ? 0 : 1);
  const whereSql = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``;

  const allowedCte = narrowed
    ? sql`allowed as (select coalesce(array_agg(c.id), '{}') as ids from contacts c ${whereSql}),`
    : sql``;
  const allowedFrom = narrowed ? sql`, allowed a` : sql``;
  const allowedCond = narrowed ? sql`and m.contact_ids && a.ids` : sql``;

  const vecLeg: SQL = vector
    ? sql`
        select id, row_number() over (order by d) as r from (
          select m.id, m.embedding <=> ${vector}::vector as d
          from memory_chunks m ${allowedFrom}
          where m.embedding is not null ${allowedCond}
          order by d
          limit ${LEG_DEPTH}
        ) x`
    : sql`select null::int as id, null::bigint as r where false`;

  const res = await getDb().execute<{
    id: number;
    full_name: string;
    headline: string | null;
    title: string | null;
    company: string | null;
    location: string | null;
    last_interaction_date: string | null;
    score: number;
    matches: number;
    evidence: Evidence[] | null;
  }>(sql`
    with
    ${allowedCte}
    -- OR the query's lexemes: plainto_tsquery ANDs them, which turns any long
    -- question into a query almost nothing matches.
    q as (
      select replace(plainto_tsquery('english', ${query})::text, ' & ', ' | ')::tsquery as tsq
    ),
    vec as (${vecLeg}),
    kw as (
      select id, row_number() over (order by rank desc) as r from (
        select m.id, ts_rank_cd(to_tsvector('english', m.text), q.tsq) as rank
        from memory_chunks m, q ${allowedFrom}
        where to_tsvector('english', m.text) @@ q.tsq ${allowedCond}
        order by rank desc
        limit ${LEG_DEPTH}
      ) x
    ),
    fused as (
      select id, sum(w / (${RRF_K} + r)) as s
      from (
        select id, r, 1.0 as w from vec
        union all
        select id, r, ${vector ? KEYWORD_WEIGHT_HYBRID : 1}::numeric as w from kw
      ) legs
      group by id
    ),
    pc as (
      select u.cid, f.s, m.kind, m.text,
        row_number() over (partition by u.cid order by f.s desc) as pos
      from fused f
      join memory_chunks m on m.id = f.id
      cross join unnest(m.contact_ids) as u(cid)
    ),
    ranked as (
      -- Best chunk dominates; the next couple add a little. Capped, because
      -- an hour-long transcript is twenty chunks, and uncapped it would
      -- outrank a single sharply relevant note on volume alone.
      select cid,
        max(s) + 0.25 * coalesce(sum(s) filter (where pos between 2 and ${1 + BONUS_CHUNKS}), 0) as score,
        count(*)::int as matches
      from pc group by cid
    )
    select
      c.id, c.full_name, c.headline, c.title, c.company, c.location,
      c.last_interaction_date,
      ranked.score::float as score,
      ranked.matches,
      (
        select json_agg(json_build_object('kind', e.kind, 'snippet', e.snippet))
        from (
          select pc.kind,
            ts_headline('english', pc.text, q.tsq,
              'MaxWords=45, MinWords=15, MaxFragments=2, FragmentDelimiter=" … ", StartSel=**, StopSel=**'
            ) as snippet
          from pc, q
          where pc.cid = c.id
          order by pc.s desc
          limit ${EVIDENCE_PER_PERSON}
        ) e
      ) as evidence
    from ranked
    join contacts c on c.id = ranked.cid
    ${whereSql}
    order by ranked.score desc
    limit ${limit}
  `);

  // Scale scores so the top hit is 1 — raw RRF values (~0.016) read as noise.
  const top = res.rows[0]?.score || 1;
  return {
    mode: vector ? "hybrid" : "keyword",
    ...(note ? { note } : {}),
    people: res.rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      headline: r.headline,
      title: r.title,
      company: r.company,
      location: r.location,
      lastInteractionDate: r.last_interaction_date,
      score: Math.round((r.score / top) * 100) / 100,
      matches: r.matches,
      evidence: r.evidence ?? [],
    })),
  };
}
