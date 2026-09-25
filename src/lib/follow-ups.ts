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

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactPhotos,
  contacts,
  drafts,
  followUps,
  followUpScans,
  type DraftChannel,
  type FollowUp,
  type FollowUpKind,
  type FollowUpSource,
} from "@/db/schema";
import { createDraft } from "@/lib/actions/drafts";
import { MCP_DRAFT_MODEL } from "@/lib/mcp-manifest";

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
 * The newest unsent draft written to close the follow-up in the outer query,
 * if any.
 *
 * Aliased and fully qualified by hand on purpose: Drizzle leaves column names
 * unqualified in a query without joins, and inside this subquery a bare "id"
 * would bind to drafts.id, not the follow-up's, and quietly match nothing.
 */
const OPEN_DRAFT_ID = sql<number | null>`(
  select d.id from ${drafts} d
  where d.follow_up_id = "follow_ups"."id" and d.sent_at is null
  order by d.id desc limit 1
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
  /** An unsent reply is waiting in Drafts. */
  hasDraft: boolean;
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
      hasDraft: sql<boolean>`${OPEN_DRAFT_ID} is not null`,
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
> & {
  lastMessageAt: Date;
  onHome: boolean;
  /** The unsent draft answering it, if one was written. */
  draftId: number | null;
};

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
      draftId: OPEN_DRAFT_ID,
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

export type DraftForFollowUpInput = {
  followUpId: number;
  /** Required only when the follow-up has no contact yet; it then gets this one. */
  contactId?: number | null;
  channel: DraftChannel;
  body: string;
  subject?: string | null;
};

export type DraftForFollowUpResult =
  | { ok: true; draftId: number; created: boolean; note?: string }
  | { ok: false; error: string };

/**
 * The reply that closes a follow-up, as an ordinary Rontext draft that also
 * remembers which follow-up it answers. It lands in Drafts and on the
 * person's timeline like any other draft, and sends the same way: the owner
 * presses the Gmail button when ready. Nothing is written to Gmail.
 *
 * One open draft per follow-up: a second call finds the first and leaves its
 * text alone, since the owner may have edited it.
 */
export async function draftForFollowUp(input: DraftForFollowUpInput): Promise<DraftForFollowUpResult> {
  const db = getDb();
  const [fu] = await db.select().from(followUps).where(eq(followUps.id, input.followUpId));
  if (!fu) return { ok: false, error: `No follow-up with id ${input.followUpId}` };

  let contactId = fu.contactId;
  if (input.contactId && contactId && input.contactId !== contactId) {
    return { ok: false, error: `Follow-up ${fu.id} belongs to contact ${contactId}, not ${input.contactId}` };
  }
  if (!contactId) {
    if (!input.contactId) {
      return {
        ok: false,
        error: `Follow-up ${fu.id} (${fu.personName}) has no contact. Find them with search_contacts and pass contact_id.`,
      };
    }
    const [c] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, input.contactId));
    if (!c) return { ok: false, error: `No contact with id ${input.contactId}` };
    contactId = c.id;
    // The agent is sure who this is; the follow-up now shows their face on Home.
    await db
      .update(followUps)
      .set({ contactId, updatedAt: new Date() })
      .where(eq(followUps.id, fu.id));
  }

  const [open] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.followUpId, fu.id), isNull(drafts.sentAt)))
    .orderBy(desc(drafts.id))
    .limit(1);
  if (open) {
    return {
      ok: true,
      draftId: open.id,
      created: false,
      note: "An unsent draft already answers this follow-up; left as is.",
    };
  }

  const draft = await createDraft(contactId, input.channel, input.body, input.subject ?? undefined, {
    generatedBody: input.body,
    generatedSubject: input.subject ?? null,
    model: MCP_DRAFT_MODEL,
    promptVersion: 0,
  });
  await db.update(drafts).set({ followUpId: fu.id }).where(eq(drafts.id, draft.id));
  return { ok: true, draftId: draft.id, created: true };
}
