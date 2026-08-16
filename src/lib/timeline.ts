import { endOfMonth, parseISO } from "date-fns";
import type {
  ContactChange,
  Draft,
  InteractionPeriod,
  Note,
  Reminder,
} from "@/db/schema";

export type TimelineItem =
  | { key: string; kind: "note"; at: Date; note: Note }
  | { key: string; kind: "reminder"; at: Date; reminder: Reminder }
  | { key: string; kind: "draft"; at: Date; draft: Draft }
  | { key: string; kind: "change"; at: Date; change: ContactChange }
  | { key: string; kind: "fact"; at: Date; label: string; date: string }
  | {
      key: string;
      kind: "period";
      at: Date;
      /** "YYYY-MM-01" */
      month: string;
      messageCount: number;
      sentCount: number;
      receivedCount: number;
      /** Calendar events that month — rendered separately from messages. */
      meetingCount: number;
    };

type TimelineSource = {
  notes: Note[];
  reminders: Reminder[];
  drafts: Draft[];
  changes: ContactChange[];
  periods: InteractionPeriod[];
  contact: {
    lastInteractionDate: string | null;
    lastLinkedinMessageDate: string | null;
    linkedinConnectedOn: string | null;
    firstInteractionDate: string | null;
  };
};

/**
 * How many monthly activity rows the feed shows.
 *
 * The feed is a feed, not a table — six is where the rows still read as "recent
 * texting rhythm" rather than as content competing with notes and drafts. Older
 * months stay in the database; they're just not worth a line here.
 */
const MAX_PERIOD_ROWS = 6;

/**
 * One merged activity feed, newest first.
 *
 * Reminders sort by when you *set* them, not when they're due — this is a log of
 * what happened, so a reminder for next year still belongs at today's position.
 *
 * Drafts are the one exception to the log. An **unsent** draft is open work, not
 * history, so it's pinned above everything else regardless of date — otherwise a
 * message you still owe someone sinks below a year of LinkedIn job changes and
 * you never see it. Once **sent** it stops being pinned and drops into the feed
 * at its `sentAt`, because by then the send is just another thing that happened.
 */
export function buildTimeline(src: TimelineSource): TimelineItem[] {
  /** Unsent drafts — always rendered first, above the dated feed. */
  const pinned: TimelineItem[] = [];
  const items: TimelineItem[] = [];

  for (const note of src.notes) {
    items.push({ key: `n${note.id}`, kind: "note", at: note.createdAt, note });
  }
  for (const reminder of src.reminders) {
    items.push({
      key: `r${reminder.id}`,
      kind: "reminder",
      at: reminder.createdAt,
      reminder,
    });
  }
  for (const draft of src.drafts) {
    const item: TimelineItem = {
      key: `d${draft.id}`,
      kind: "draft",
      at: draft.sentAt ?? draft.createdAt,
      draft,
    };
    (draft.sentAt ? items : pinned).push(item);
  }
  for (const change of src.changes) {
    items.push({ key: `c${change.id}`, kind: "change", at: change.createdAt, change });
  }

  // Monthly activity. Sources are merged so someone you both text and email
  // gets one line per month rather than two, and a month with no traffic simply
  // has no row to begin with — a person you talk to in bursts costs three lines
  // a year, not twelve.
  // Calendar buckets are meetings, not messages: they get their own count so
  // the row can say "12 messages · 2 meetings" rather than mislabel a meeting.
  const byMonth = new Map<string, { m: number; s: number; r: number; k: number }>();
  for (const p of src.periods) {
    const prev = byMonth.get(p.month) ?? { m: 0, s: 0, r: 0, k: 0 };
    if (p.source === "calendar") {
      prev.k += p.messageCount;
    } else {
      prev.m += p.messageCount;
      prev.s += p.sentCount;
      prev.r += p.receivedCount;
    }
    byMonth.set(p.month, prev);
  }
  const now = new Date();
  const shownMonths = [...byMonth.keys()].sort().reverse().slice(0, MAX_PERIOD_ROWS);
  for (const month of shownMonths) {
    const t = byMonth.get(month)!;
    // Sort at the month's end so a July bucket sits above a July 3 note — it
    // summarizes the whole month — but below anything in August. Clamped to now
    // so the current month doesn't float above genuinely-newer entries.
    const end = endOfMonth(parseISO(month));
    items.push({
      key: `p${month}`,
      kind: "period",
      at: end > now ? now : end,
      month,
      messageCount: t.m,
      sentCount: t.s,
      receivedCount: t.r,
      meetingCount: t.k,
    });
  }
  /** Does a date fall inside a month that already has an activity row? */
  const coveredByPeriod = (date: string) => shownMonths.includes(date.slice(0, 7) + "-01");

  const c = src.contact;
  const fact = (label: string, date: string | null) => {
    if (!date) return;
    items.push({ key: `f${label}`, kind: "fact", at: parseISO(date), label, date });
  };
  // The interaction facts are suppressed when an activity row already covers
  // that month — "Last interaction — Aug 11" directly above "Aug 2026 · 24
  // texts" is just restating the bucket's own boundary. The LinkedIn facts are
  // never covered, so they always render.
  if (!c.lastInteractionDate || !coveredByPeriod(c.lastInteractionDate)) {
    fact("Last interaction", c.lastInteractionDate);
  }
  if (c.lastLinkedinMessageDate !== c.lastInteractionDate) {
    fact("Last LinkedIn message", c.lastLinkedinMessageDate);
  }
  fact("Connected on LinkedIn", c.linkedinConnectedOn);
  if (!c.firstInteractionDate || !coveredByPeriod(c.firstInteractionDate)) {
    fact("First interaction", c.firstInteractionDate);
  }

  const newestFirst = (a: TimelineItem, b: TimelineItem) =>
    b.at.getTime() - a.at.getTime();
  pinned.sort(newestFirst);
  items.sort(newestFirst);
  return [...pinned, ...items];
}
