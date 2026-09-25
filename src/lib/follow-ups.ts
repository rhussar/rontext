/**
 * Follow-ups: the open loops inside conversations — "I'll send you context
 * later", "ping me if you haven't heard by the 24th" — as rows Home can show.
 *
 * Rontext doesn't find these itself. Its Gmail sync is metadata-only by design
 * (src/lib/gmail-sync.ts), and a thread whose last message is yours looks
 * finished to every count-based signal, which is exactly how a promise slips.
 * An agent reads the thread (the follow-ups skill, over the Gmail connector),
 * decides what's still owed, and saves it through MCP `save_follow_ups`. This
 * module validates and stores what it sends, and serves Home and the agent.
 *
 * Plain module, not "use server": the write path is for the MCP route only.
 * The owner's own actions (done, snooze, dismiss) live in
 * src/lib/actions/follow-ups.ts.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactPhotos,
  contacts,
  followUps,
  followUpScans,
  type FollowUp,
  type FollowUpKind,
  type FollowUpSource,
} from "@/db/schema";

/**
 * A `waiting` loop with no date named in the thread becomes due this long
 * after the last message: long enough that nudging isn't pushy.
 */
export const WAITING_DEFAULT_DAYS = 7;

/** Home marks a follow-up "New" for this long after an agent first saves it. */
const NEW_FOR_HOURS = 72;

export type FollowUpInput = {
  key: string;
  kind: FollowUpKind;
  title: string;
  detail?: string | null;
  /** YYYY-MM-DD. */
  dueOn?: string | null;
  personName: string;
  personEmail?: string | null;
  contactId?: number | null;
};

export type SaveFollowUpsInput = {
  source: FollowUpSource;
  threadRef: string;
  link?: string | null;
  /** The newest message the agent read — the thread's change detector. */
  lastMessageAt: Date;
  /** Every loop still open in the thread. Empty means none are. */
  loops: FollowUpInput[];
  author: string;
};

export type SaveFollowUpsResult =
  | {
      ok: true;
      created: string[];
      updated: string[];
      /** Agent-closed earlier, open again now. */
      reopened: string[];
      /** Open before, not in this save: the thread shows it closed. */
      resolved: string[];
      /** The owner marked these done or dismissed; the save left that alone. */
      keptClosed: string[];
      /** Saved without a contact: nobody in the book has this address. */
      unmatched: string[];
    }
  | { ok: false; error: string };

/** https only: "View" opens this in a new tab. */
export function safeLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const clean = (s: string | null | undefined) => s?.trim() || null;

/**
 * Save everything still open in one thread, replacing what the last scan of it
 * said. Matching is by `key`, so a re-scan updates rows in place:
 *  - a key seen again is updated; if the agent had resolved it, it reopens
 *  - a key not seen again, still open, becomes `resolved`
 *  - done and dismissed are the owner's calls, never overridden
 *
 * Refuses a save older than the last scan of the same thread, so two agents
 * (or a slow run) can't resurrect loops from a thread that has moved on.
 */
export async function saveFollowUps(input: SaveFollowUpsInput): Promise<SaveFollowUpsResult> {
  const db = getDb();
  const { source, threadRef } = input;

  const keys = input.loops.map((l) => l.key);
  if (new Set(keys).size !== keys.length) {
    return { ok: false, error: "Each loop in a thread needs its own key" };
  }

  const [scan] = await db
    .select({ lastMessageAt: followUpScans.lastMessageAt })
    .from(followUpScans)
    .where(and(eq(followUpScans.source, source), eq(followUpScans.threadRef, threadRef)));
  if (scan && input.lastMessageAt.getTime() < scan.lastMessageAt.getTime()) {
    return {
      ok: false,
      error: `Stale: this thread was already scanned through ${scan.lastMessageAt.toISOString()}. Re-read it and save again.`,
    };
  }

  const contactFor = await resolveContacts(input.loops);
  const existing = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.source, source), eq(followUps.threadRef, threadRef)));
  const byKey = new Map(existing.map((r) => [r.key, r]));

  const now = new Date();
  const link = safeLink(input.link);
  const result = {
    created: [] as string[],
    updated: [] as string[],
    reopened: [] as string[],
    resolved: [] as string[],
    keptClosed: [] as string[],
    unmatched: [] as string[],
  };

  for (const loop of input.loops) {
    const contactId = contactFor(loop);
    const fields = {
      kind: loop.kind,
      title: loop.title.trim(),
      detail: clean(loop.detail),
      dueOn: loop.dueOn ?? null,
      personName: loop.personName.trim(),
      personEmail: clean(loop.personEmail)?.toLowerCase() ?? null,
      link,
      lastMessageAt: input.lastMessageAt,
      author: input.author,
      updatedAt: now,
    };
    const prev = byKey.get(loop.key);
    if (!prev) {
      await db.insert(followUps).values({ ...fields, source, threadRef, key: loop.key, contactId });
      result.created.push(loop.key);
    } else {
      const reopen = prev.status === "resolved";
      await db
        .update(followUps)
        .set({
          ...fields,
          // A contact the owner (or an earlier match) set stays unless this
          // save found one.
          contactId: contactId ?? prev.contactId,
          ...(reopen ? { status: "open" as const, closedAt: null } : {}),
        })
        .where(eq(followUps.id, prev.id));
      if (reopen) result.reopened.push(loop.key);
      else if (prev.status === "done" || prev.status === "dismissed") result.keptClosed.push(loop.key);
      else result.updated.push(loop.key);
    }
    if (!contactId && !prev?.contactId) result.unmatched.push(fields.personName);
  }

  const seen = new Set(keys);
  const gone = existing.filter((r) => r.status === "open" && !seen.has(r.key));
  if (gone.length) {
    await db
      .update(followUps)
      .set({ status: "resolved", closedAt: now, updatedAt: now })
      .where(inArray(followUps.id, gone.map((r) => r.id)));
    result.resolved.push(...gone.map((r) => r.key));
  }

  await db
    .insert(followUpScans)
    .values({ source, threadRef, lastMessageAt: input.lastMessageAt, scannedAt: now })
    .onConflictDoUpdate({
      target: [followUpScans.source, followUpScans.threadRef],
      set: { lastMessageAt: input.lastMessageAt, scannedAt: now },
    });

  return { ok: true, ...result, unmatched: [...new Set(result.unmatched)] };
}

/**
 * contact_id when it names a real contact, else the person's address matched
 * against contacts.emails (case-insensitive, archived people skipped). Never by
 * name: two Dans in the book is normal, and a wrong match is worse than none.
 */
async function resolveContacts(loops: FollowUpInput[]) {
  const db = getDb();
  const ids = [...new Set(loops.map((l) => l.contactId).filter((x): x is number => !!x))];
  const emails = [
    ...new Set(loops.map((l) => l.personEmail?.trim().toLowerCase()).filter((x): x is string => !!x)),
  ];

  const live = new Set<number>();
  if (ids.length) {
    const rows = await db.select({ id: contacts.id }).from(contacts).where(inArray(contacts.id, ids));
    rows.forEach((r) => live.add(r.id));
  }
  const byEmail = new Map<string, number>();
  if (emails.length) {
    const res = await db.execute<{ id: number; email: string }>(sql`
      select c.id, lower(e) as email
      from ${contacts} c, unnest(c.emails) e
      where c.archived_at is null
        and lower(e) in (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})
      order by c.id
    `);
    // Lowest id wins when two records share an address — the older record,
    // which a later merge would keep anyway.
    for (const r of res.rows) if (!byEmail.has(r.email)) byEmail.set(r.email, Number(r.id));
  }

  return (l: FollowUpInput): number | null =>
    (l.contactId && live.has(l.contactId) ? l.contactId : null) ??
    (l.personEmail ? byEmail.get(l.personEmail.trim().toLowerCase()) ?? null : null);
}

/**
 * When a loop is due: its own date, or for an undated `waiting` loop, a week
 * after the last message. Null for undated promises and asks.
 */
const EFFECTIVE_DUE = sql`coalesce(
  ${followUps.dueOn},
  case when ${followUps.kind} = 'waiting'
    then (${followUps.lastMessageAt} + make_interval(days => ${WAITING_DEFAULT_DAYS}))::date
  end
)`;

/**
 * The SQL form of "belongs on Home": open, not snoozed, and — for `waiting` —
 * past its nudge date. Written once so Home and the agent's `onHome` flag agree.
 */
const ON_HOME = sql<boolean>`(
  ${followUps.status} = 'open'
  and (${followUps.snoozedUntil} is null or ${followUps.snoozedUntil} <= now())
  and (${followUps.kind} <> 'waiting' or ${EFFECTIVE_DUE} <= current_date)
)`;

export type HomeFollowUp = {
  id: number;
  source: FollowUpSource;
  kind: FollowUpKind;
  title: string;
  detail: string | null;
  dueOn: string | null;
  link: string | null;
  contactId: number | null;
  personName: string;
  hasPhoto: boolean;
  lastMessageAt: string;
  /** Computed here, not in the client, for the same hydration reason as reminders. */
  overdue: boolean;
  isNew: boolean;
};

export async function listHomeFollowUps(): Promise<HomeFollowUp[]> {
  const rows = await getDb()
    .select({
      id: followUps.id,
      source: followUps.source,
      kind: followUps.kind,
      title: followUps.title,
      detail: followUps.detail,
      dueOn: followUps.dueOn,
      link: followUps.link,
      contactId: followUps.contactId,
      personName: sql<string>`coalesce(${contacts.fullName}, ${followUps.personName})`,
      hasPhoto: sql<boolean>`${contactPhotos.contactId} is not null`,
      lastMessageAt: followUps.lastMessageAt,
      createdAt: followUps.createdAt,
      overdue: sql<boolean>`${followUps.dueOn} is not null and ${followUps.dueOn} < current_date`,
    })
    .from(followUps)
    .leftJoin(contacts, eq(contacts.id, followUps.contactId))
    .leftJoin(contactPhotos, eq(contactPhotos.contactId, followUps.contactId))
    .where(ON_HOME)
    // Dated loops first, most overdue at the top; then undated, newest first.
    .orderBy(sql`${EFFECTIVE_DUE} asc nulls last`, sql`${followUps.createdAt} desc`);

  const newSince = Date.now() - NEW_FOR_HOURS * 3_600_000;
  return rows.map(({ createdAt, ...r }) => ({
    ...r,
    lastMessageAt: r.lastMessageAt.toISOString(),
    isNew: createdAt.getTime() >= newSince,
  }));
}

/** Open loops with one person, for get_person_context. Snoozed ones included. */
export async function openFollowUpsFor(contactId: number) {
  return getDb()
    .select({
      id: followUps.id,
      kind: followUps.kind,
      title: followUps.title,
      detail: followUps.detail,
      dueOn: followUps.dueOn,
      source: followUps.source,
      lastMessageAt: followUps.lastMessageAt,
    })
    .from(followUps)
    .where(and(eq(followUps.contactId, contactId), eq(followUps.status, "open")))
    .orderBy(sql`${followUps.dueOn} is null`, asc(followUps.dueOn));
}

type AgentRow = Pick<
  FollowUp,
  "id" | "source" | "threadRef" | "key" | "kind" | "title" | "detail" | "dueOn" | "contactId" | "personName" | "status"
> & { lastMessageAt: Date; onHome: boolean };

/**
 * What an agent needs before scanning: the keys already used in the threads
 * it's about to read (so a re-scan updates rows instead of duplicating them),
 * and how far each thread was read (so unchanged threads can be skipped).
 * Without thread refs, every open follow-up.
 */
export async function listFollowUpsForAgent(opts: {
  source?: FollowUpSource;
  threadRefs?: string[];
}): Promise<{
  followUps: AgentRow[];
  scans?: { threadRef: string; source: FollowUpSource; lastMessageAt: Date }[];
}> {
  const db = getDb();
  const refs = opts.threadRefs?.length ? opts.threadRefs : null;
  const where = and(
    opts.source ? eq(followUps.source, opts.source) : undefined,
    refs ? inArray(followUps.threadRef, refs) : eq(followUps.status, "open"),
  );
  const rows = await db
    .select({
      id: followUps.id,
      source: followUps.source,
      threadRef: followUps.threadRef,
      key: followUps.key,
      kind: followUps.kind,
      title: followUps.title,
      detail: followUps.detail,
      dueOn: followUps.dueOn,
      contactId: followUps.contactId,
      personName: followUps.personName,
      status: followUps.status,
      lastMessageAt: followUps.lastMessageAt,
      onHome: ON_HOME,
    })
    .from(followUps)
    .where(where)
    .orderBy(asc(followUps.threadRef), asc(followUps.key));

  if (!refs) return { followUps: rows };
  const scans = await db
    .select({
      threadRef: followUpScans.threadRef,
      source: followUpScans.source,
      lastMessageAt: followUpScans.lastMessageAt,
    })
    .from(followUpScans)
    .where(
      and(
        opts.source ? eq(followUpScans.source, opts.source) : undefined,
        inArray(followUpScans.threadRef, refs),
      ),
    );
  return { followUps: rows, scans };
}
