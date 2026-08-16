/**
 * Gmail → per-correspondent counts → ingestHandles(). The reader behind both
 * scripts/ingest-gmail.ts (CLI, file or app credentials) and the daily job in
 * src/lib/jobs/gmail.ts.
 *
 * **Metadata only.** Every fetch uses format=metadata with an explicit header
 * allowlist, so no subject line and no message body is ever requested, let
 * alone stored. That's enforced by the request shape, not by discipline.
 *
 * Two windows:
 *  - `{ months: 12 }`   — the CLI's default and a fresh install's first run:
 *                         Gmail's relative `newer_than:12m`.
 *  - `{ sinceMonth }`   — the daily job: `after:YYYY/MM/01` from the *first of
 *                         the previous month*, so every month in the window is
 *                         scanned completely. That alignment is what keeps the
 *                         greatest() merge in interaction_periods honest: a
 *                         window that starts mid-month yields a partial first
 *                         month, and a partial count that lands first would be
 *                         frozen as the "largest" forever. Months older than
 *                         the window are never rescanned — they were completed
 *                         by whichever run covered them and stay put.
 *
 * Truncation (the `max` cap, or the deadline) suppresses monthly buckets for
 * the whole run for the same reason: the cap drops the *oldest* mail, so a
 * month would read "3 emails" when there were 200. Totals still merge safely
 * because they, too, take the greater value.
 */
import { GMAIL_API, googleGet } from "@/lib/google-auth";
import {
  ingestHandles,
  type ConnectorSummary,
  type HandleAggregate,
} from "@/lib/connector-ingest";
import type { PeriodTally } from "@/db/schema";

/** Headers we ask for. Deliberately no Subject. */
const HEADERS = ["From", "To", "Cc", "List-Unsubscribe"];

/**
 * Addresses that are machinery, not people. These slip past the two-way test
 * whenever you've ever replied to a ticket robot.
 */
const JUNK_LOCAL =
  /^(no-?reply|do-?not-?reply|notifications?|mailer|bounce|postmaster|support|billing|invoices?|receipts?|automated|alerts?|updates?|news|info|hello|team|admin)([+.-]|$)/i;

type MessageMeta = {
  id: string;
  internalDate: string;
  payload?: { headers?: { name: string; value: string }[] };
};

/** "Jane Doe <jane@x.com>, bob@y.com" → [{name, email}] */
export function parseAddresses(raw: string): { name: string | null; email: string }[] {
  const out: { name: string | null; email: string }[] = [];
  // Split on commas that aren't inside a quoted display name.
  for (const part of raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const chunk = part.trim();
    if (!chunk) continue;
    const angled = chunk.match(/^(.*?)<([^>]+)>$/);
    const email = (angled ? angled[2] : chunk).trim().toLowerCase();
    if (!email.includes("@")) continue;
    let name = angled ? angled[1].trim().replace(/^"|"$/g, "").trim() : "";
    // Gmail writes the address itself as the display name when there isn't one.
    if (name.toLowerCase() === email) name = "";
    out.push({ name: name || null, email });
  }
  return out;
}

function header(msg: MessageMeta, name: string): string | null {
  const hit = msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return hit?.value ?? null;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/**
 * UTC, since that's what iso() above already uses. The Messages reader buckets
 * in *local* time — a near-midnight message can therefore land either side of a
 * month boundary depending on which connector saw it. Pre-existing, harmless at
 * this granularity, and not worth two date pipelines to reconcile.
 */
const month = (ms: number) => iso(ms).slice(0, 7) + "-01";

type Tally = {
  handle: string;
  displayName: string | null;
  sentCount: number;
  receivedCount: number;
  first: number;
  last: number;
  months: Map<string, PeriodTally>;
};

function record(
  tallies: Map<string, Tally>,
  addr: { name: string | null; email: string },
  direction: "sent" | "received",
  ts: number,
) {
  const t = tallies.get(addr.email) ?? {
    handle: addr.email,
    displayName: null,
    sentCount: 0,
    receivedCount: 0,
    first: ts,
    last: ts,
    months: new Map<string, PeriodTally>(),
  };
  if (direction === "sent") t.sentCount++;
  else t.receivedCount++;
  if (!t.displayName && addr.name) t.displayName = addr.name;
  if (ts < t.first) t.first = ts;
  if (ts > t.last) t.last = ts;

  const key = month(ts);
  const bucket = t.months.get(key) ?? { month: key, messageCount: 0, sentCount: 0, receivedCount: 0 };
  bucket.messageCount++;
  if (direction === "sent") bucket.sentCount++;
  else bucket.receivedCount++;
  t.months.set(key, bucket);

  tallies.set(addr.email, t);
}

export type GmailWindow =
  /** Gmail's relative window — `newer_than:Nm`. */
  | { months: number }
  /** Calendar-aligned — `after:YYYY/MM/DD`, a "YYYY-MM-01" string. */
  | { sinceMonth: string };

export type GmailSyncOptions = {
  accessToken: string;
  /** The mailbox owner, lowercased, so their own address is never a correspondent. */
  me: string;
  window: GmailWindow;
  /** Per-pass cap on messages read. Beyond it the run is "truncated". */
  max?: number;
  /** Epoch ms; passes stop listing/fetching past this and the run is truncated. */
  deadline?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
};

export type GmailSyncSummary = ConnectorSummary & {
  me: string;
  windowLabel: string;
  sentRead: number;
  inboxRead: number;
  addressesSeen: number;
  junkFiltered: number;
  kept: number;
  truncated: boolean;
  /** Set when the deadline cut the run short — a `max` truncation is just `truncated`. */
  deadlineHit: boolean;
};

/** "YYYY-MM-01" for the first day of the month `offset` months before now (UTC). */
export function monthStart(offset = 0, now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  return d.toISOString().slice(0, 10);
}

function windowQuery(w: GmailWindow): { q: string; label: string } {
  if ("months" in w) return { q: `newer_than:${w.months}m`, label: `last ${w.months} months` };
  // Gmail wants YYYY/MM/DD in `after:`.
  const [y, m, d] = w.sinceMonth.split("-");
  return { q: `after:${y}/${m}/${d}`, label: `since ${w.sinceMonth}` };
}

/** Run `fn` over items with bounded concurrency — Gmail rate-limits hard above ~10. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  shouldStop: () => boolean,
): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length && !shouldStop()) {
        const i = cursor++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function syncGmail(opts: GmailSyncOptions): Promise<GmailSyncSummary> {
  const log = opts.log ?? (() => {});
  const max = opts.max ?? 5000;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const pastDeadline = () => Date.now() >= deadline;
  const { q: windowQ, label } = windowQuery(opts.window);
  const me = opts.me.toLowerCase();

  let deadlineHit = false;
  let truncated = false;

  async function listIds(q: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      if (pastDeadline()) {
        deadlineHit = true;
        break;
      }
      const page = await googleGet<{ messages?: { id: string }[]; nextPageToken?: string }>(
        opts.accessToken,
        `${GMAIL_API}/messages`,
        { q, maxResults: "500", ...(pageToken ? { pageToken } : {}) },
      );
      for (const m of page.messages ?? []) ids.push(m.id);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < max);
    if (ids.length > max) truncated = true;
    if (pageToken && ids.length >= max) truncated = true;
    return ids.slice(0, max);
  }

  async function fetchMeta(ids: string[]): Promise<MessageMeta[]> {
    const rows = await pooled(
      ids,
      10,
      (id) =>
        googleGet<MessageMeta>(opts.accessToken, `${GMAIL_API}/messages/${id}`, {
          format: "metadata",
          metadataHeaders: HEADERS,
        }).catch(() => null),
      pastDeadline,
    );
    if (rows.length < ids.length) deadlineHit = true;
    return rows.filter((r): r is MessageMeta => r != null);
  }

  const tallies = new Map<string, Tally>();

  // Pass 1: what you sent. People you email are people you know, and this is a
  // fraction of the volume of a whole mailbox.
  const sentIds = await listIds(`in:sent ${windowQ}`);
  const sentMeta = await fetchMeta(sentIds);
  log(`  ${sentMeta.length}/${sentIds.length} sent messages read`);
  for (const msg of sentMeta) {
    const ts = Number(msg.internalDate);
    for (const field of ["To", "Cc"]) {
      const raw = header(msg, field);
      if (!raw) continue;
      for (const addr of parseAddresses(raw)) {
        if (addr.email === me) continue;
        record(tallies, addr, "sent", ts);
      }
    }
  }

  // Pass 2: what came back. Category filters strip promotions and social before
  // they can become candidates.
  const inboxIds = deadlineHit
    ? []
    : await listIds(
        `in:inbox ${windowQ} -category:promotions -category:social -category:updates -category:forums`,
      );
  const inboxMeta = await fetchMeta(inboxIds);
  log(`  ${inboxMeta.length}/${inboxIds.length} inbox messages read`);
  for (const msg of inboxMeta) {
    // A List-Unsubscribe header means a mailing list, however personal it looks.
    if (header(msg, "List-Unsubscribe")) continue;
    const from = header(msg, "From");
    if (!from) continue;
    const ts = Number(msg.internalDate);
    for (const addr of parseAddresses(from)) {
      if (addr.email === me) continue;
      record(tallies, addr, "received", ts);
    }
  }

  const suppressBuckets = truncated || deadlineHit;
  if (suppressBuckets) {
    log(
      `  NOTE: run truncated (${deadlineHit ? "time budget" : `max ${max}`}) — monthly buckets ` +
        `suppressed for this run so a partial month can't be frozen as complete. Totals still merge.`,
    );
  }

  const rows: HandleAggregate[] = [];
  let junk = 0;
  for (const t of tallies.values()) {
    if (JUNK_LOCAL.test(t.handle.split("@")[0])) {
      junk++;
      continue;
    }
    rows.push({
      handle: t.handle,
      displayName: t.displayName,
      messageCount: t.sentCount + t.receivedCount,
      sentCount: t.sentCount,
      receivedCount: t.receivedCount,
      firstAt: iso(t.first),
      lastAt: iso(t.last),
      periods: suppressBuckets
        ? undefined
        : [...t.months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    });
  }
  log(`  ${tallies.size} addresses seen, ${junk} filtered as automated, ${rows.length} kept`);

  const summary = await ingestHandles("gmail", "email", rows, { dryRun: opts.dryRun });
  return {
    ...summary,
    me,
    windowLabel: label,
    sentRead: sentMeta.length,
    inboxRead: inboxMeta.length,
    addressesSeen: tallies.size,
    junkFiltered: junk,
    kept: rows.length,
    truncated: truncated || deadlineHit,
    deadlineHit,
  };
}
