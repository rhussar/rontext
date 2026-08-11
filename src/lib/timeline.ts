import { parseISO } from "date-fns";
import type { ContactChange, Draft, Note, Reminder } from "@/db/schema";

export type TimelineItem =
  | { key: string; kind: "note"; at: Date; note: Note }
  | { key: string; kind: "reminder"; at: Date; reminder: Reminder }
  | { key: string; kind: "draft"; at: Date; draft: Draft }
  | { key: string; kind: "change"; at: Date; change: ContactChange }
  | { key: string; kind: "fact"; at: Date; label: string; date: string };

type TimelineSource = {
  notes: Note[];
  reminders: Reminder[];
  drafts: Draft[];
  changes: ContactChange[];
  contact: {
    lastInteractionDate: string | null;
    lastLinkedinMessageDate: string | null;
    linkedinConnectedOn: string | null;
    firstInteractionDate: string | null;
  };
};

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

  const c = src.contact;
  const fact = (label: string, date: string | null) => {
    if (!date) return;
    items.push({ key: `f${label}`, kind: "fact", at: parseISO(date), label, date });
  };
  fact("Last interaction", c.lastInteractionDate);
  if (c.lastLinkedinMessageDate !== c.lastInteractionDate) {
    fact("Last LinkedIn message", c.lastLinkedinMessageDate);
  }
  fact("Connected on LinkedIn", c.linkedinConnectedOn);
  fact("First interaction", c.firstInteractionDate);

  const newestFirst = (a: TimelineItem, b: TimelineItem) =>
    b.at.getTime() - a.at.getTime();
  pinned.sort(newestFirst);
  items.sort(newestFirst);
  return [...pinned, ...items];
}
