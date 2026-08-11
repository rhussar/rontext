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

/** Same order as AVATAR_COLORS — WebGL can't read Tailwind classes. */
const AVATAR_HEX = [
  "#0ea5e9", // sky-500
  "#10b981", // emerald-500
  "#8b5cf6", // violet-500
  "#f59e0b", // amber-500
  "#f43f5e", // rose-500
  "#14b8a6", // teal-500
  "#6366f1", // indigo-500
  "#f97316", // orange-500
  "#0891b2", // cyan-600
  "#d946ef", // fuchsia-500
];

function avatarIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % AVATAR_COLORS.length;
}

export function avatarColor(seed: string): string {
  return AVATAR_COLORS[avatarIndex(seed)];
}

/**
 * Hex twin of `avatarColor`, same hash and same index order — a person's dot on
 * the graph canvas is the same color as their avatar in the people list.
 */
export function avatarHex(seed: string): string {
  return AVATAR_HEX[avatarIndex(seed)];
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

/** "Aug 15 2026 at 2:30 PM" — reminder due dates, which unlike notes carry a time. */
export function reminderDateTime(date: Date | string): string {
  const d = typeof date === "string" ? parseISO(date) : date;
  return format(d, "MMM d yyyy 'at' h:mm a");
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

/**
 * The role we already knew, written the way LinkedIn writes a headline
 * ("Title at Company"), so the two can be diffed against each other.
 */
export function roleLine(
  title: string | null | undefined,
  company: string | null | undefined,
): string | null {
  const t = title?.trim() || null;
  const c = company?.trim() || null;
  if (t && c) return `${t} at ${c}`;
  return t ?? c;
}

/** Display labels for contact_changes.field values. */
export const CHANGE_FIELD_LABELS: Record<string, string> = {
  connected: "New connection",
  fullName: "Name",
  company: "Company",
  title: "Title",
  headline: "Headline",
  location: "Location",
  linkedinUrl: "LinkedIn URL",
  emails: "Emails",
  phoneNumbers: "Phones",
};

/**
 * "+14134090674" → "+1 (413) 409-0674". Anything that isn't a NANP number
 * (international, short codes, extensions) is returned untouched rather than
 * forced into a shape it doesn't fit.
 */
export function formatPhone(raw: string): string {
  const v = (raw ?? "").trim();
  const d = v.replace(/\D/g, "");
  const local = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (local.length !== 10) return v;
  // A leading "+" that isn't +1 means a non-US country code — leave it alone
  if (v.startsWith("+") && d.length === 11 && !d.startsWith("1")) return v;
  return `+1 (${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
}

/** True when a contact's name is really just a phone number (no name on file). */
export function isPhoneLikeName(name: string): boolean {
  const v = (name ?? "").trim();
  if (!v || !/^[+(]?\d/.test(v)) return false;
  if (/[a-z]/i.test(v)) return false;
  return v.replace(/\D/g, "").length >= 10;
}

/** Contact names that are bare phone numbers get formatted for display. */
export function displayName(name: string): string {
  return isPhoneLikeName(name) ? formatPhone(name) : name;
}
