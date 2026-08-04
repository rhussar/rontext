import {
  differenceInCalendarDays,
  format,
  formatDistanceToNowStrict,
  parse,
  parseISO,
} from "date-fns";

export function initials(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return "?";
  // Phone-number "names" get a # symbol instead of a digit
  if (/^\+?\d/.test(cleaned)) return "#";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  // [...s][0] is code-point safe (emoji, accents) — s[0] would split surrogate pairs
  const first = [...parts[0]][0] ?? "?";
  if (parts.length === 1) return first.toUpperCase();
  const last = [...parts[parts.length - 1]][0] ?? "";
  return (first + last).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-sky-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-orange-500",
  "bg-cyan-600",
  "bg-fuchsia-500",
];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export const GROUP_COLORS = [
  "#f97316", // orange
  "#3b82f6", // blue
  "#10b981", // emerald
  "#8b5cf6", // violet
  "#ef4444", // red
  "#eab308", // yellow
  "#06b6d4", // cyan
  "#ec4899", // pink
];

/** Parse a CSV date that may be ISO (2025-02-24) or US (6/17/2004) into ISO, or null. */
export function parseCsvDate(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    d = parseISO(v.slice(0, 10));
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)) {
    d = parse(v, "M/d/yyyy", new Date());
  } else {
    d = new Date(v);
  }
  return isNaN(d.getTime()) ? null : format(d, "yyyy-MM-dd");
}

/** "JUN 14 2026" — the note-date style from Mesh. */
export function noteDate(date: Date | string): string {
  const d = typeof date === "string" ? parseISO(date) : date;
  return format(d, "MMM d yyyy").toUpperCase();
}

/** "3 months ago" */
export function ago(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  const d = typeof date === "string" ? parseISO(date) : date;
  if (isNaN(d.getTime())) return null;
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

/** "Jun 17" (no year) for birthdays */
export function birthdayShort(iso: string): string {
  return format(parseISO(iso), "MMMM d");
}

/** Days until next occurrence of a birthday (0 = today). */
export function daysUntilBirthday(iso: string, from = new Date()): number {
  const b = parseISO(iso);
  const next = new Date(from.getFullYear(), b.getMonth(), b.getDate());
  if (
    differenceInCalendarDays(next, from) < 0
  ) {
    next.setFullYear(from.getFullYear() + 1);
  }
  return differenceInCalendarDays(next, from);
}

/** The plain-language "sources" sentence, like Mesh's right panel. */
export function reachOutSentence(c: {
  fullName: string;
  firstName?: string | null;
  lastInteractionDate?: string | null;
  lastLinkedinMessageDate?: string | null;
  linkedinConnectedOn?: string | null;
  linkedinUrl?: string | null;
  interactionSources?: string[];
}): string {
  const name = c.firstName || c.fullName.split(" ")[0];
  const parts: string[] = [];
  const last = c.lastInteractionDate;
  if (last) {
    const rel = ago(last);
    if (rel) parts.push(`You last interacted with ${name} ${rel}.`);
  }
  if (c.lastLinkedinMessageDate) {
    const rel = ago(c.lastLinkedinMessageDate);
    if (rel) parts.push(`Last LinkedIn message ${rel}.`);
  }
  if (c.linkedinUrl) {
    if (c.linkedinConnectedOn) {
      parts.push(
        `You've been connected on LinkedIn since ${format(parseISO(c.linkedinConnectedOn), "MMMM yyyy")}.`,
      );
    } else {
      parts.push(`You're connected on LinkedIn.`);
    }
  }
  if (parts.length === 0 && c.interactionSources?.length) {
    parts.push(`Known from ${c.interactionSources.join(", ")}.`);
  }
  return parts.join(" ");
}

export function linkedinSlug(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    const seg = u.pathname.split("/").filter(Boolean);
    return seg[seg.length - 1] ?? url;
  } catch {
    return url;
  }
}
