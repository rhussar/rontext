/**
 * Keeps `memory_chunks` in step with the CRM.
 *
 * Two phases, deliberately separable:
 *
 *  1. syncChunks() — rebuild the *desired* chunk set from contacts, notes and
 *     meetings, diff it against the table, write only the difference. Pure
 *     SQL and hashing: no API calls, no cost, safe to run on every request
 *     that wants fresh results. A changed chunk gets its vector cleared.
 *  2. embedPending() — give a vector to every chunk that lacks one (or has
 *     one from a different model), in batches, until a deadline.
 *
 * Keyword search works after phase 1 alone, which is what lets the index be
 * useful before an embedding key exists and fresh between embedding runs.
 *
 * Plain module, not "use server" — the daily job, the MCP route and the CLI
 * backfill all call it.
 */

import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appState, memoryChunks, type MemoryKind } from "@/db/schema";
import {
  EMBED_BATCH,
  EMBEDDING_MODEL,
  EmbeddingRateLimitError,
  embed,
  embeddingKey,
  toVectorLiteral,
} from "@/lib/memory/embeddings";

/**
 * Chunk size in characters. ~2,000 chars is ~450 tokens: long enough that a
 * note or a meeting paragraph keeps its context, short enough that one match
 * isn't diluted by a page of unrelated transcript.
 */
const CHUNK_CHARS = 2_000;
const CHUNK_OVERLAP = 200;

/** Rows per INSERT — keeps a statement's parameter count well under Postgres's 65k. */
const WRITE_BATCH = 200;

const REFRESHED_KEY = "memoryRefreshedAt";

type DesiredChunk = {
  kind: MemoryKind;
  sourceId: number;
  chunkIndex: number;
  contactIds: number[];
  text: string;
  contentHash: string;
};

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function keyOf(c: { kind: string; sourceId: number; chunkIndex: number }): string {
  return `${c.kind}:${c.sourceId}:${c.chunkIndex}`;
}

/**
 * Split text into ~CHUNK_CHARS pieces, preferring paragraph, then sentence,
 * boundaries, with a short overlap so an idea straddling a cut is still whole
 * in one of the two chunks.
 */
export function splitText(text: string, max = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.trim();
  if (clean.length <= max) return clean ? [clean] : [];

  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + max, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      // Latest good boundary in the back half of the window.
      const para = window.lastIndexOf("\n\n");
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
      const cut = para > max / 2 ? para : sentence > max / 2 ? sentence + 1 : -1;
      if (cut > 0) end = start + cut;
    }
    out.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out.filter(Boolean);
}

function line(label: string, value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? `${label}: ${v}` : null;
}

/* ------------------------------------------------------------------ *
 * Desired state
 * ------------------------------------------------------------------ */

/**
 * One profile chunk per contact: every structured fact, flattened into a
 * short document. Built deterministically from the row, so it is always
 * current and costs nothing — an LLM-written summary, when one exists in
 * contact_enrichment, is appended rather than substituted.
 */
async function profileChunks(): Promise<DesiredChunk[]> {
  const res = await getDb().execute<{
    id: number;
    full_name: string;
    headline: string | null;
    title: string | null;
    company: string | null;
    location: string | null;
    hometown: string | null;
    group_names: string[];
    education: string[];
    entities: string[];
    seniority: string | null;
    job_function: string | null;
    summary: string | null;
  }>(sql`
    select
      c.id, c.full_name, c.headline, c.title, c.company, c.location, c.hometown,
      coalesce((
        select array_agg(gr.name order by gr.name)
        from contact_groups cg join groups gr on gr.id = cg.group_id
        where cg.contact_id = c.id
      ), '{}') as group_names,
      coalesce((
        select array_agg(
          concat_ws(', ', ed.school, ed.degree,
            case when ed.start_year is not null or ed.end_year is not null
              then concat(coalesce(ed.start_year::text, ''), '–', coalesce(ed.end_year::text, ''))
            end)
          order by ed.end_year desc nulls first)
        from contact_education ed where ed.contact_id = c.id
      ), '{}') as education,
      coalesce((
        select array_agg(distinct e.type || ':' || e.name)
        from contact_entities ce join entities e on e.id = ce.entity_id
        where ce.contact_id = c.id and e.type in ('industry', 'function', 'school')
      ), '{}') as entities,
      en.seniority, en.job_function, en.summary
    from contacts c
    left join contact_enrichment en on en.contact_id = c.id
  `);

  return res.rows.map((r) => {
    const role =
      r.title && r.company ? `${r.title} at ${r.company}` : (r.title ?? r.company);
    const byType = (t: string) =>
      r.entities.filter((e) => e.startsWith(`${t}:`)).map((e) => e.slice(t.length + 1));
    const typedSchools = r.education.join(" ").toLowerCase();
    const extraSchools = byType("school").filter((s) => !typedSchools.includes(s.toLowerCase()));

    const text = [
      r.full_name,
      line("Headline", r.headline),
      line("Role", role),
      line("Lives in", r.location),
      line("From", r.hometown),
      line("Groups", r.group_names.join(", ")),
      line("Education", [...r.education, ...extraSchools].join("; ")),
      line("Industry", byType("industry").join(", ")),
      line("Function", [r.job_function, ...byType("function")].filter(Boolean).join(", ")),
      line("Seniority", r.seniority),
      line("Summary", r.summary),
    ]
      .filter(Boolean)
      .join("\n");

    return {
      kind: "profile" as const,
      sourceId: r.id,
      chunkIndex: 0,
      contactIds: [r.id],
      text,
      contentHash: hash(text),
    };
  });
}

/**
 * Notes, prefixed with whose note it is — the evidence has to name the person
 * when it's shown on its own, and the prefix is a few tokens next to the body.
 */
async function noteChunks(): Promise<DesiredChunk[]> {
  const res = await getDb().execute<{
    id: number;
    contact_id: number;
    full_name: string;
    body: string;
  }>(sql`
    select n.id, n.contact_id, c.full_name, n.body
    from notes n join contacts c on c.id = n.contact_id
  `);
  return res.rows.flatMap((r) =>
    splitText(r.body).map((piece, i) => {
      const text = `Note about ${r.full_name}:\n${piece}`;
      return {
        kind: "note" as const,
        sourceId: r.id,
        chunkIndex: i,
        contactIds: [r.contact_id],
        text,
        contentHash: hash(text),
      };
    }),
  );
}

/**
 * Meetings attached to at least one person. Unresolved and dismissed meetings
 * are left out: a hit nobody can be attributed to can't answer "who".
 * Every chunk repeats the header so a transcript fragment still says which
 * meeting, and with whom, it came from.
 */
async function meetingChunks(): Promise<DesiredChunk[]> {
  const res = await getDb().execute<{
    id: number;
    title: string;
    started_at: string;
    summary: string | null;
    notes: string | null;
    transcript: string | null;
    contact_ids: number[];
    names: string[];
  }>(sql`
    select m.id, m.title, m.started_at, m.summary, m.notes, m.transcript,
      array_agg(mc.contact_id order by mc.contact_id) as contact_ids,
      array_agg(c.full_name order by mc.contact_id) as names
    from meetings m
    join meeting_contacts mc on mc.meeting_id = m.id
    join contacts c on c.id = mc.contact_id
    where m.dismissed_at is null
    group by m.id
  `);

  return res.rows.flatMap((r) => {
    const date = new Date(r.started_at).toISOString().slice(0, 10);
    const header = `Meeting "${r.title}" on ${date} with ${r.names.join(", ")}`;
    const pieces = [
      ...splitText([r.summary, r.notes].filter(Boolean).join("\n\n")),
      ...splitText(r.transcript ?? ""),
    ];
    return pieces.map((piece, i) => {
      const text = `${header}:\n${piece}`;
      return {
        kind: "meeting" as const,
        sourceId: r.id,
        chunkIndex: i,
        contactIds: r.contact_ids,
        text,
        contentHash: hash(text),
      };
    });
  });
}

/* ------------------------------------------------------------------ *
 * Phase 1: diff and write
 * ------------------------------------------------------------------ */

export type SyncSummary = {
  chunks: number;
  inserted: number;
  changed: number;
  relinked: number;
  deleted: number;
};

export async function syncChunks(): Promise<SyncSummary> {
  const db = getDb();
  const [profiles, notesC, meetingsC, existing] = await Promise.all([
    profileChunks(),
    noteChunks(),
    meetingChunks(),
    db
      .select({
        id: memoryChunks.id,
        kind: memoryChunks.kind,
        sourceId: memoryChunks.sourceId,
        chunkIndex: memoryChunks.chunkIndex,
        contentHash: memoryChunks.contentHash,
        contactIds: memoryChunks.contactIds,
      })
      .from(memoryChunks),
  ]);
  const desired = [...profiles, ...notesC, ...meetingsC];

  const have = new Map(existing.map((e) => [keyOf(e), e]));
  const want = new Set<string>();
  const upserts: DesiredChunk[] = [];
  const relinks: { id: number; ids: number[] }[] = [];
  let inserted = 0;

  for (const d of desired) {
    const k = keyOf(d);
    want.add(k);
    const cur = have.get(k);
    if (!cur) {
      upserts.push(d);
      inserted++;
    } else if (cur.contentHash !== d.contentHash) {
      upserts.push(d);
    } else if (cur.contactIds.join(",") !== d.contactIds.join(",")) {
      relinks.push({ id: cur.id, ids: d.contactIds });
    }
  }
  const stale = existing.filter((e) => !want.has(keyOf(e))).map((e) => e.id);

  for (let i = 0; i < upserts.length; i += WRITE_BATCH) {
    await db
      .insert(memoryChunks)
      .values(upserts.slice(i, i + WRITE_BATCH))
      .onConflictDoUpdate({
        target: [memoryChunks.kind, memoryChunks.sourceId, memoryChunks.chunkIndex],
        // New text means the old vector describes something else — clear it
        // so embedPending() picks the row up.
        set: {
          text: sql`excluded.text`,
          contentHash: sql`excluded.content_hash`,
          contactIds: sql`excluded.contact_ids`,
          embedding: null,
          embeddingModel: null,
          embeddedAt: null,
          updatedAt: new Date(),
        },
      });
  }

  if (relinks.length) {
    await db.execute(sql`
      update memory_chunks m set contact_ids = v.ids, updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(relinks)}::jsonb) as v(id int, ids int[])
      where m.id = v.id
    `);
  }

  for (let i = 0; i < stale.length; i += WRITE_BATCH) {
    await db.delete(memoryChunks).where(inArray(memoryChunks.id, stale.slice(i, i + WRITE_BATCH)));
  }

  return {
    chunks: desired.length,
    inserted,
    changed: upserts.length - inserted,
    relinked: relinks.length,
    deleted: stale.length,
  };
}

/* ------------------------------------------------------------------ *
 * Phase 2: embed
 * ------------------------------------------------------------------ */

export type EmbedSummary = {
  /** False when no VOYAGE_API_KEY is configured — the index is keyword-only. */
  configured: boolean;
  embedded: number;
  /** Still without a current vector when the deadline or an error stopped us. */
  pending: number;
  error?: string;
};

async function countPending(): Promise<number> {
  const res = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n from memory_chunks
    where embedding is null or embedding_model is distinct from ${EMBEDDING_MODEL}
  `);
  return res.rows[0]?.n ?? 0;
}

export async function embedPending(deadline: number): Promise<EmbedSummary> {
  const apiKey = await embeddingKey();
  if (!apiKey) return { configured: false, embedded: 0, pending: await countPending() };

  const db = getDb();
  let embedded = 0;
  let error: string | undefined;

  // Leave room for the write after the last embed call.
  while (Date.now() < deadline - 5_000) {
    const batch = await db.execute<{ id: number; text: string }>(sql`
      select id, text from memory_chunks
      where embedding is null or embedding_model is distinct from ${EMBEDDING_MODEL}
      order by id
      limit ${EMBED_BATCH}
    `);
    if (batch.rows.length === 0) break;

    let vectors: number[][];
    try {
      vectors = await embed(apiKey, batch.rows.map((r) => r.text), "document");
    } catch (err) {
      // A rate limit is a pause, not a failure: wait it out if the deadline
      // allows, and otherwise stop quietly — the rows stay pending and the
      // next run picks them up. Only real errors are reported.
      if (err instanceof EmbeddingRateLimitError) {
        if (Date.now() + err.retryAfterMs < deadline - 5_000) {
          await new Promise((r) => setTimeout(r, err.retryAfterMs));
          continue;
        }
        break;
      }
      error = err instanceof Error ? err.message : String(err);
      break;
    }

    const payload = batch.rows.map((r, i) => ({ id: r.id, e: toVectorLiteral(vectors[i]) }));
    await db.execute(sql`
      update memory_chunks m
      set embedding = v.e::vector, embedding_model = ${EMBEDDING_MODEL}, embedded_at = now()
      from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) as v(id int, e text)
      where m.id = v.id
    `);
    embedded += batch.rows.length;
  }

  return { configured: true, embedded, pending: await countPending(), error };
}

/* ------------------------------------------------------------------ *
 * Both, with a freshness stamp
 * ------------------------------------------------------------------ */

export type RefreshSummary = SyncSummary & EmbedSummary;

export async function refreshMemory(deadline: number): Promise<RefreshSummary> {
  const synced = await syncChunks();
  const embedded = await embedPending(deadline);
  await getDb()
    .insert(appState)
    .values({ key: REFRESHED_KEY, value: new Date().toISOString() })
    .onConflictDoUpdate({
      target: appState.key,
      set: { value: sql`excluded.value`, updatedAt: new Date() },
    });
  return { ...synced, ...embedded };
}

/** When refreshMemory() last completed, or null if it never has. */
export async function memoryRefreshedAt(): Promise<Date | null> {
  const res = await getDb().execute<{ value: string }>(
    sql`select value from app_state where key = ${REFRESHED_KEY}`,
  );
  const v = res.rows[0]?.value;
  return v ? new Date(v) : null;
}
