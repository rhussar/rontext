import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactCandidates,
  contactChanges,
  contacts,
  syncRuns,
  type Connector,
  type InteractionSource,
  type PeriodTally,
} from "@/db/schema";
import {
  rollupInteractions,
  upsertInteractionPeriods,
  upsertInteractions,
  type InteractionInput,
  type InteractionPeriodInput,
} from "@/lib/interactions";

export type { PeriodTally };
import { normalizeName } from "@/lib/duplicates";

/**
 * One correspondent, already aggregated by the reader.
 *
 * Both connectors reduce to this same shape before touching the database:
 * Messages counts per iMessage/SMS handle, Gmail counts per email address.
 * Neither carries any message content — by the time a row gets here it is
 * counts and dates only.
 */
export type HandleAggregate = {
  /** A phone number, or an email address. */
  handle: string;
  /** From a From: header where one exists; null for iMessage handles. */
  displayName?: string | null;
  messageCount: number;
  sentCount: number;
  receivedCount: number;
  /** "YYYY-MM-DD" */
  firstAt: string;
  lastAt: string;
  /**
   * Per-month breakdown, feeding interaction_periods. Optional: a connector
   * that can't produce a trustworthy one omits it and contributes no buckets,
   * which is the right failure mode — a month that reads "3 emails" when there
   * were 200 is worse than no month at all, and greatest() would freeze the
   * wrong number permanently.
   */
  periods?: PeriodTally[];
};

export type ConnectorSummary = {
  ok: boolean;
  error?: string;
  /** Correspondents left after filtering. */
  scanned: number;
  matched: number;
  /** Existing contacts whose record actually changed (new email/phone). */
  enriched: number;
  /** Rows now sitting in the review queue, including earlier runs'. */
  candidatesPending: number;
  /** Candidates created by *this* run. */
  candidatesNew: number;
  /** Monthly buckets written to interaction_periods. */
  periods: number;
  rolledUp: number;
  details: { handle: string; contact: string | null; note: string }[];
};

const digits = (s: string) => s.replace(/\D/g, "");
const emailKey = (s: string) => s.trim().toLowerCase();
const isEmail = (s: string) => s.includes("@");

/**
 * Match key for a handle. Emails match on the lowercased address; phones on the
 * last 10 digits, the same key contacts-import-core.ts already builds. That key
 * is NANP-biased — an international number that collides simply fails to match
 * and lands in the review queue, which is the safe direction to be wrong in.
 *
 * Returns null for anything too short to be a phone number: shortcodes are
 * 2FA prompts, banks and delivery bots, never people.
 */
export function handleKey(handle: string): string | null {
  if (isEmail(handle)) return `e:${emailKey(handle)}`;
  const d = digits(handle);
  return d.length >= 7 ? `p:${d.slice(-10)}` : null;
}

/**
 * Fold per-handle rows down to one row per person. The same human shows up
 * once per service (SMS and iMessage are separate handle rows) and sometimes
 * once per number format, so without this a single friend becomes three
 * candidates.
 */
export function mergeByKey(rows: HandleAggregate[]): Map<string, HandleAggregate> {
  const out = new Map<string, HandleAggregate>();
  for (const r of rows) {
    const key = handleKey(r.handle);
    if (!key) continue;
    const normalized = isEmail(r.handle) ? emailKey(r.handle) : r.handle;
    const prev = out.get(key);
    if (!prev) {
      // `periods` is deep-copied on purpose. A plain spread aliases the array
      // *and its objects* to the caller's row, and the merge branch below then
      // mutates them in place — silently corrupting the reader's own data on
      // the second handle for the same person.
      out.set(key, {
        ...r,
        handle: normalized,
        periods: r.periods?.map((p) => ({ ...p })),
      });
      continue;
    }
    prev.messageCount += r.messageCount;
    prev.sentCount += r.sentCount;
    prev.receivedCount += r.receivedCount;
    if (r.firstAt < prev.firstAt) prev.firstAt = r.firstAt;
    if (r.lastAt > prev.lastAt) prev.lastAt = r.lastAt;
    if (!prev.displayName && r.displayName) prev.displayName = r.displayName;
    // Prefer the longer handle: "+14155551234" beats "4155551234".
    if (normalized.length > prev.handle.length) prev.handle = normalized;
    if (r.periods?.length) prev.periods = mergePeriods(prev.periods, r.periods);
  }
  return out;
}

/**
 * Sum two months-lists into one, so a phone handle and an Apple ID email
 * belonging to the same person produce a single row per month rather than two.
 * Mirrors how the totals above are summed.
 */
function mergePeriods(a: PeriodTally[] | undefined, b: PeriodTally[]): PeriodTally[] {
  const byMonth = new Map<string, PeriodTally>();
  for (const p of a ?? []) byMonth.set(p.month, { ...p });
  for (const p of b) {
    const prev = byMonth.get(p.month);
    if (!prev) {
      byMonth.set(p.month, { ...p });
      continue;
    }
    prev.messageCount += p.messageCount;
    prev.sentCount += p.sentCount;
    prev.receivedCount += p.receivedCount;
  }
  return [...byMonth.values()].sort((x, y) => x.month.localeCompare(y.month));
}

/**
 * A correspondent is only a person if you actually replied to them. One-way
 * traffic is a delivery notification, a verification code or a marketing
 * blast — exactly the stuff that would otherwise bury the review queue.
 */
export function isConversation(r: HandleAggregate, minMessages = 2): boolean {
  return r.messageCount >= minMessages && r.sentCount >= 1;
}

/**
 * Push aggregated correspondents into the CRM.
 *
 * Two paths, and the split is the whole safety story: a handle that matches an
 * existing contact enriches it in place, and a handle that doesn't becomes a
 * *candidate* for review. Nothing here ever creates a contact — one unfiltered
 * sync would otherwise bury a hand-curated CRM under delivery bots. The only
 * route from a connector to a new contact is acceptCandidate().
 *
 * @param connector which integration ran ("gmail")
 * @param source    the interaction vocabulary it writes ("email"), matching the
 *                  values already in contacts.interactionSources
 */
export async function ingestHandles(
  connector: Connector,
  source: InteractionSource,
  rows: HandleAggregate[],
  opts: {
    dryRun?: boolean;
    /**
     * Two-way threshold for *matching* an existing contact (default 2 —
     * isConversation). Calendar passes 1: one meeting with someone already in
     * the CRM is an interaction worth recording.
     */
    minMessages?: number;
    /**
     * Threshold for creating a *candidate* (default = minMessages). Calendar
     * keeps this at 2 so a one-off meeting with a stranger doesn't queue them.
     */
    candidateMinMessages?: number;
  } = {},
): Promise<ConnectorSummary> {
  const summary: ConnectorSummary = {
    ok: false,
    scanned: 0,
    matched: 0,
    enriched: 0,
    candidatesPending: 0,
    candidatesNew: 0,
    periods: 0,
    rolledUp: 0,
    details: [],
  };

  const minMessages = opts.minMessages ?? 2;
  const candidateMin = opts.candidateMinMessages ?? minMessages;
  const merged = mergeByKey(rows);
  const people = [...merged.entries()].filter(([, r]) => isConversation(r, minMessages));
  summary.scanned = people.length;

  const db = getDb();
  const existing = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      emails: contacts.emails,
      phoneNumbers: contacts.phoneNumbers,
    })
    .from(contacts);

  // Same index shape as contacts-import-core.ts, keyed the same way.
  const byKey = new Map<string, (typeof existing)[number]>();
  const byName = new Map<string, (typeof existing)[number] | "dup">();
  for (const c of existing) {
    for (const e of c.emails) if (e) byKey.set(`e:${emailKey(e)}`, c);
    for (const p of c.phoneNumbers) {
      const d = digits(p);
      if (d.length >= 7) byKey.set(`p:${d.slice(-10)}`, c);
    }
    const n = normalizeName(c.fullName);
    if (n) byName.set(n, byName.has(n) ? "dup" : c);
  }

  const interactionRows: InteractionInput[] = [];
  const periodRows: InteractionPeriodInput[] = [];
  // Queued rather than written inline: the bulk interaction insert is the call
  // most likely to fail, and writing candidates first would leave the queue
  // populated by a run that never finished.
  const newCandidates: Parameters<typeof upsertCandidate>[1][] = [];

  for (const [key, agg] of people) {
    // Identifier first. Falling back to an exact, unambiguous name is what
    // actually fills gaps: most contacts arrived from LinkedIn with a name and
    // no email, so "Jane Doe <jane@x.com>" is the only thing that can attach an
    // address to them. Same rule import-core.ts and linkedin-ingest.ts use —
    // a name shared by two contacts matches neither.
    let match = byKey.get(key);
    let viaName = false;
    if (!match && agg.displayName) {
      const hit = byName.get(normalizeName(agg.displayName));
      if (hit && hit !== "dup") {
        match = hit;
        viaName = true;
      }
    }

    if (!match) {
      if (agg.messageCount < candidateMin) continue;
      newCandidates.push({
        handle: agg.handle,
        displayName: agg.displayName ?? null,
        messageCount: agg.messageCount,
        sentCount: agg.sentCount,
        receivedCount: agg.receivedCount,
        firstAt: agg.firstAt,
        lastAt: agg.lastAt,
        periods: agg.periods ?? [],
      });
      if (opts.dryRun) summary.candidatesNew++;
      summary.details.push({
        handle: agg.handle,
        contact: null,
        note: `${agg.messageCount} messages, last ${agg.lastAt} — to review`,
      });
      continue;
    }

    summary.matched++;
    interactionRows.push({
      contactId: match.id,
      source,
      firstAt: agg.firstAt,
      lastAt: agg.lastAt,
      messageCount: agg.messageCount,
      sentCount: agg.sentCount,
      receivedCount: agg.receivedCount,
    });
    for (const p of agg.periods ?? []) {
      periodRows.push({ contactId: match.id, source, ...p });
    }

    // Append-only: add the handle if we don't have it, never replace one.
    const field = isEmail(agg.handle) ? "emails" : "phoneNumbers";
    const current = field === "emails" ? match.emails : match.phoneNumbers;
    const known = isEmail(agg.handle)
      ? current.some((v) => emailKey(v) === emailKey(agg.handle))
      : current.some((v) => digits(v).slice(-10) === digits(agg.handle).slice(-10));

    if (!known) {
      summary.enriched++;
      summary.details.push({
        handle: agg.handle,
        contact: match.fullName,
        note: viaName ? `matched by name → added to ${field}` : `added to ${field}`,
      });
      if (!opts.dryRun) {
        const next = [...current, agg.handle];
        await db
          .update(contacts)
          .set({ [field]: next, updatedAt: new Date() })
          .where(eq(contacts.id, match.id));
        await db.insert(contactChanges).values({
          contactId: match.id,
          field,
          oldValue: current.join("; ") || null,
          newValue: next.join("; "),
          source: connector,
        });
      }
    }
  }

  if (!opts.dryRun) {
    await upsertInteractions(interactionRows);
    // Two writes, and neon-http has no interactive transactions — a failure in
    // between leaves totals without their monthly breakdown. Both are
    // idempotent upserts, so the next sync heals it; nothing reads one against
    // the other, so the split is invisible until then.
    summary.periods = await upsertInteractionPeriods(periodRows);
    summary.rolledUp = await rollupInteractions();
    for (const c of newCandidates) {
      if (await upsertCandidate(connector, c)) summary.candidatesNew++;
    }
    await db.insert(syncRuns).values({
      connector,
      scanned: summary.scanned,
      matched: summary.matched,
      enriched: summary.enriched,
      candidates: summary.candidatesNew,
    });
  }

  summary.candidatesPending = await countPending(connector);
  summary.ok = true;
  return summary;
}

/**
 * Upsert a candidate, refreshing counts on a row that's still pending.
 *
 * `setWhere` is what makes "not a person" stick: a dismissed row is left
 * untouched by every later sync, so declining someone declines them for good
 * instead of putting them back in the queue next week.
 *
 * Returns true when this was a genuinely new candidate.
 */
export async function upsertCandidate(
  source: Connector,
  row: {
    handle: string;
    displayName: string | null;
    messageCount: number;
    sentCount: number;
    receivedCount: number;
    firstAt: string;
    lastAt: string;
    periods: PeriodTally[];
  },
): Promise<boolean> {
  const now = new Date();
  const inserted = await getDb()
    .insert(contactCandidates)
    .values({ source, ...row, updatedAt: now })
    .onConflictDoUpdate({
      target: [contactCandidates.source, contactCandidates.handle],
      set: {
        displayName: sql`coalesce(excluded.display_name, ${contactCandidates.displayName})`,
        messageCount: sql`greatest(${contactCandidates.messageCount}, excluded.message_count)`,
        sentCount: sql`greatest(${contactCandidates.sentCount}, excluded.sent_count)`,
        receivedCount: sql`greatest(${contactCandidates.receivedCount}, excluded.received_count)`,
        firstAt: sql`least(${contactCandidates.firstAt}, excluded.first_at)`,
        lastAt: sql`greatest(${contactCandidates.lastAt}, excluded.last_at)`,
        // Taken wholesale rather than merged month-by-month: the connector
        // recomputes its entire window every run, so the more complete scan is
        // simply more correct. Guarding on the total stops a narrow --months
        // run from replacing a wide one's history with a shorter list.
        periods: sql`case when excluded.message_count >= ${contactCandidates.messageCount}
                          then excluded.periods else ${contactCandidates.periods} end`,
        updatedAt: now,
      },
      setWhere: eq(contactCandidates.status, "pending"),
    })
    // xmax is 0 only on a genuine insert — the standard way to tell an upsert's
    // two outcomes apart. A dismissed row fails setWhere and returns nothing.
    .returning({ isNew: sql<boolean>`(xmax = 0)` });

  return inserted[0]?.isNew ?? false;
}

export async function countPending(source: Connector): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(contactCandidates)
    .where(
      and(
        eq(contactCandidates.source, source),
        eq(contactCandidates.status, "pending"),
      ),
    );
  return row?.n ?? 0;
}
