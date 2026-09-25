/**
 * Warm paths to a person, a company, or "someone who…" — the MCP
 * `intro_paths` tool.
 *
 * Every contact is already one hop from the owner, so the question is never
 * "is there a path" but "which path is warm". A path is scored as:
 *
 *     closeness(owner → introducer) × strength(introducer → target)
 *
 * and compared against simply reaching out directly, closeness(owner →
 * target). Both halves come with plain-language reasons, because an intro
 * request is only as good as the sentence explaining why this person.
 *
 * Closeness is observed behaviour: message volume and recency from the
 * connectors, notes, recorded meetings, starred.
 *
 * Strength comes from evidence the two know each other, strongest first:
 *   - small, active iMessage group chats together (contact_links)
 *   - recorded meetings together (meeting_contacts)
 *   - a shared employer, weighted by how small it is in the book
 *   - a shared small group (cohort, program)
 *   - a shared school, weighted down hard — alumni of a big school mostly
 *     don't know each other
 * Inferred signals are deliberately weaker than observed ones.
 */

import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactFilterSql } from "@/lib/contact-search";
import { findPeople } from "@/lib/memory/search";

/** Beyond these sizes a shared group/school/company says nothing about knowing someone. */
const MAX_GROUP = 100;
const MAX_SCHOOL = 300;
const MAX_COMPANY = 50;
/** Edge strength saturates here — three strong signals is already certain. */
const EDGE_CAP = 4;
/** An intro costs a favour; reaching out directly doesn't. */
const INTRO_DISCOUNT = 0.85;
const MAX_TARGETS = 40;
const INTRODUCERS_PER_TARGET = 3;
/** Below this an intro is a guess, not a path — shown as a lead, not recommended. */
const WARM_INTRO = 0.2;
/** When reaching out directly wins, only list introducers at least this strong. */
const ALTERNATIVE_INTRO = 0.3;
/** An introducer weaker than this is noise (e.g. cohort-only links). */
const MIN_INTRODUCER = 0.05;

export type IntroTarget =
  | { contactId: number }
  | { company: string }
  | { query: string };

type Closeness = {
  score: number;
  label: "close" | "in touch" | "distant";
  /** "1,240 messages · last 2026-09-12 · starred" */
  facts: string;
};

export type Introducer = {
  id: number;
  fullName: string;
  headline: string | null;
  you: Closeness;
  /** How the introducer knows the target, strongest first. */
  howTheyKnowTarget: string[];
  score: number;
};

export type IntroPath = {
  target: { id: number; fullName: string; headline: string | null; company: string | null };
  /** Your own tie to the target — often the best path is no intro at all. */
  direct: Closeness;
  introducers: Introducer[];
  /** max(direct, best intro × discount); comparable across targets in one reply. */
  best: number;
  /** How well the target matched a query target (1 for a contact or company). */
  relevance: number;
  recommendation: "reach out directly" | "ask for an intro" | "weak leads only" | "no warm path";
};

type PersonRow = {
  id: number;
  full_name: string;
  headline: string | null;
  title: string | null;
  company: string | null;
  starred: boolean;
  msgs: number;
  last_at: string | null;
  notes: number;
  meetings: number;
};

function closeness(p: PersonRow): Closeness {
  const volume = Math.min(1, Math.log1p(p.msgs) / Math.log1p(500));
  const days = p.last_at ? (Date.now() - Date.parse(p.last_at)) / 86_400_000 : null;
  const recency = days === null ? 0 : Math.exp(-Math.max(days, 0) / 180);
  const score = Math.min(
    1,
    0.02 +
      0.55 * volume +
      0.25 * recency +
      0.1 * Math.min(1, p.notes / 3) +
      0.1 * Math.min(1, p.meetings) +
      (p.starred ? 0.15 : 0),
  );
  const facts = [
    p.msgs ? `${p.msgs.toLocaleString()} messages` : "no messages on record",
    p.last_at ? `last ${p.last_at}` : null,
    p.notes ? `${p.notes} note${p.notes === 1 ? "" : "s"}` : null,
    p.meetings ? `${p.meetings} recorded meeting${p.meetings === 1 ? "" : "s"}` : null,
    p.starred ? "starred" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    score: Math.round(score * 100) / 100,
    label: score >= 0.5 ? "close" : score >= 0.2 ? "in touch" : "distant",
    facts,
  };
}

/** Target ids with how well each matched (1 when the target was named outright). */
async function resolveTargets(t: IntroTarget): Promise<Map<number, number>> {
  if ("contactId" in t) return new Map([[t.contactId, 1]]);
  if ("query" in t) {
    const r = await findPeople(t.query, {}, 15);
    return new Map(r.people.map((p) => [p.id, p.score]));
  }
  const where = contactFilterSql({ company: t.company });
  const res = await getDb().execute<{ id: number }>(sql`
    select c.id from contacts c
    where ${sql.join(where, sql` and `)}
    order by c.last_interaction_date desc nulls last
    limit ${MAX_TARGETS}
  `);
  return new Map(res.rows.map((r) => [r.id, 1]));
}

/** Everyone active, with the inputs to closeness(). ~2k rows, one round trip. */
async function loadPeople(): Promise<Map<number, PersonRow>> {
  const res = await getDb().execute<PersonRow>(sql`
    select c.id, c.full_name, c.headline, c.title, c.company, c.starred,
      coalesce(i.msgs, 0)::int as msgs,
      greatest(i.last_at, c.last_interaction_date)::text as last_at,
      (select count(*)::int from notes n where n.contact_id = c.id) as notes,
      (select count(*)::int from meeting_contacts mc where mc.contact_id = c.id) as meetings
    from contacts c
    left join (
      select contact_id, sum(message_count) as msgs, max(last_at) as last_at
      from interactions group by contact_id
    ) i on i.contact_id = c.id
    where c.archived_at is null
  `);
  return new Map(res.rows.map((r) => [r.id, r]));
}

type EdgeRow = {
  target: number;
  other: number;
  kind: "imessage_group" | "meeting" | "company" | "group" | "school";
  label: string | null;
  n: number;
  messages: number | null;
  last_at: string | null;
};

/** Every evidence row linking a target to anyone else. */
async function loadEdges(targets: number[]): Promise<EdgeRow[]> {
  // An array literal, not the JS array: drizzle's sql template spreads an
  // array into one parameter per element. Safe to build — they're integers.
  const ids = `{${targets.map((n) => Math.trunc(n)).join(",")}}`;
  const res = await getDb().execute<EdgeRow>(sql`
    with t as (select unnest(${ids}::int[]) as id)
    select t.id as target,
      case when l.contact_a = t.id then l.contact_b else l.contact_a end as other,
      'imessage_group' as kind, null as label, l.threads as n, l.messages, l.last_at::text
    from t join contact_links l on t.id in (l.contact_a, l.contact_b)

    union all
    select t.id, mc2.contact_id, 'meeting', null, count(*)::int, null, max(m.started_at)::date::text
    from t
    join meeting_contacts mc1 on mc1.contact_id = t.id
    join meeting_contacts mc2 on mc2.meeting_id = mc1.meeting_id and mc2.contact_id <> t.id
    join meetings m on m.id = mc1.meeting_id
    group by t.id, mc2.contact_id

    union all
    select distinct t.id, ce2.contact_id, 'company', e.name, e.member_count, null::int, null::text
    from t
    join contact_entities ce1 on ce1.contact_id = t.id and ce1.role = 'employee'
    join entities e on e.id = ce1.entity_id and e.type = 'company'
      and e.member_count between 2 and ${MAX_COMPANY}
    join contact_entities ce2 on ce2.entity_id = e.id and ce2.role = 'employee'
      and ce2.contact_id <> t.id

    union all
    select t.id, cg2.contact_id, 'group', g.name, gs.n, null::int, null::text
    from t
    join contact_groups cg1 on cg1.contact_id = t.id
    join (select group_id, count(*)::int as n from contact_groups group by group_id) gs
      on gs.group_id = cg1.group_id and gs.n <= ${MAX_GROUP}
    join groups g on g.id = cg1.group_id
    join contact_groups cg2 on cg2.group_id = cg1.group_id and cg2.contact_id <> t.id

    union all
    select distinct t.id, ce2.contact_id, 'school', e.name, e.member_count, null::int, null::text
    from t
    join contact_entities ce1 on ce1.contact_id = t.id and ce1.role = 'alum'
    join entities e on e.id = ce1.entity_id and e.type = 'school'
      and e.member_count between 2 and ${MAX_SCHOOL}
    join contact_entities ce2 on ce2.entity_id = e.id and ce2.role = 'alum'
      and ce2.contact_id <> t.id
  `);
  return res.rows;
}

function weigh(e: EdgeRow): { w: number; reason: string } {
  switch (e.kind) {
    case "imessage_group": {
      const msgs = e.messages ?? 0;
      return {
        w: 2 + Math.min(1.5, Math.log1p(msgs) / 4) + (e.n > 1 ? 0.5 : 0),
        reason:
          `in ${e.n} group chat${e.n === 1 ? "" : "s"} together with you` +
          (e.last_at ? ` (active until ${e.last_at.slice(0, 7)})` : ""),
      };
    }
    case "meeting":
      return {
        w: Math.min(4, 2 * e.n),
        reason: `in ${e.n} recorded meeting${e.n === 1 ? "" : "s"} together`,
      };
    case "company":
      return { w: 2 / Math.sqrt(e.n), reason: `both at ${e.label} (${e.n} people in your book)` };
    case "group":
      return { w: 3 / Math.sqrt(e.n), reason: `both in your "${e.label}" group (${e.n})` };
    case "school":
      return { w: 1 / Math.sqrt(e.n), reason: `both studied at ${e.label}` };
  }
}

export async function introPaths(target: IntroTarget, limit = 10): Promise<IntroPath[]> {
  const relevance = await resolveTargets(target);
  const targetIds = [...relevance.keys()].slice(0, MAX_TARGETS);
  if (targetIds.length === 0) return [];

  const [people, edges] = await Promise.all([loadPeople(), loadEdges(targetIds)]);

  // target → other → accumulated evidence
  type Evidence = { w: number; reasons: { w: number; r: string }[] };
  const byTarget = new Map<number, Map<number, Evidence>>();
  for (const e of edges) {
    if (!people.has(e.other)) continue; // archived
    const { w, reason } = weigh(e);
    const m = byTarget.get(e.target) ?? new Map<number, Evidence>();
    const acc = m.get(e.other) ?? { w: 0, reasons: [] };
    acc.w += w;
    acc.reasons.push({ w, r: reason });
    m.set(e.other, acc);
    byTarget.set(e.target, m);
  }

  const paths: IntroPath[] = [];
  for (const id of targetIds) {
    const t = people.get(id);
    if (!t) continue;
    const direct = closeness(t);

    const introducers: Introducer[] = [...(byTarget.get(id) ?? new Map<number, Evidence>()).entries()]
      .map(([otherId, acc]) => {
        const o = people.get(otherId)!;
        const you = closeness(o);
        const strength = Math.min(acc.w, EDGE_CAP) / EDGE_CAP;
        return {
          id: o.id,
          fullName: o.full_name,
          headline: o.headline ?? (o.title && o.company ? `${o.title} at ${o.company}` : o.company),
          you,
          howTheyKnowTarget: acc.reasons.sort((a, b) => b.w - a.w).map((x) => x.r),
          score: Math.round(you.score * strength * 100) / 100,
        };
      })
      // An introducer you're not in touch with is no warmer than a cold email.
      .filter((i) => i.you.label !== "distant" && i.score >= MIN_INTRODUCER)
      .sort((a, b) => b.score - a.score)
      .slice(0, INTRODUCERS_PER_TARGET);

    const bestIntro = (introducers[0]?.score ?? 0) * INTRO_DISCOUNT;
    const best = Math.max(direct.score, bestIntro);
    const recommendation: IntroPath["recommendation"] =
      direct.label !== "distant" && direct.score >= bestIntro
        ? "reach out directly"
        : bestIntro >= WARM_INTRO
          ? "ask for an intro"
          : introducers.length
            ? "weak leads only"
            : "no warm path";
    paths.push({
      target: { id: t.id, fullName: t.full_name, headline: t.headline, company: t.company },
      direct,
      // When going direct wins, an intro list is clutter unless one is a
      // genuinely strong alternative.
      introducers:
        recommendation === "reach out directly"
          ? introducers.filter((i) => i.score >= ALTERNATIVE_INTRO)
          : introducers,
      best: Math.round(best * 100) / 100,
      relevance: relevance.get(id) ?? 1,
      recommendation,
    });
  }

  // For a query, a warm path to the wrong person is worth little: order by
  // match quality, lifted by warmth — never by warmth alone.
  return paths
    .sort((a, b) => b.relevance * (0.4 + 0.6 * b.best) - a.relevance * (0.4 + 0.6 * a.best))
    .slice(0, limit);
}
