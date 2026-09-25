import type { DraftChannel, InteractionSource } from "@/db/schema";

export const CHANNEL_LABELS: Record<DraftChannel, string> = {
  email: "Email",
  sms: "Text",
  whatsapp: "WhatsApp",
  linkedin: "LinkedIn",
};

/** Article included — "a"/"an" can't be derived from the label ("an email", "a text"). */
export const CHANNEL_PHRASES: Record<DraftChannel, string> = {
  email: "an email",
  sms: "a text",
  whatsapp: "a WhatsApp message",
  linkedin: "a LinkedIn message",
};

/** Past tense, for the timeline row a draft becomes once it's been sent. */
export const CHANNEL_SENT_LABELS: Record<DraftChannel, string> = {
  email: "Sent an email",
  sms: "Sent a text",
  whatsapp: "Sent a WhatsApp message",
  linkedin: "Sent a LinkedIn message",
};

/**
 * mailto: and sms: are handed straight to the OS URL handler, which truncates
 * an over-long URL silently rather than erroring — a half-written message would
 * open with no warning. 1800 sits under the smallest limit anything in this
 * chain enforces. Gmail's https compose tolerates more but also drops very long
 * `body` params, so one cap covers them all.
 */
const MAX_URL = 1800;

/**
 * encodeURIComponent, never URLSearchParams. URLSearchParams encodes a space as
 * "+", which is only correct for form-urlencoded bodies — mailto: (RFC 6068),
 * sms: (RFC 5724) and Gmail's compose all render that "+" literally, so every
 * space in a draft would arrive as a plus sign.
 */
const q = (v: string) => encodeURIComponent(v);

/** The one identifier each channel needs. Index 0 is canonical app-wide. */
export type OutreachTarget = {
  email: string | null;
  phone: string | null;
  /** The WhatsApp number when known, else the primary phone. */
  whatsapp: string | null;
  linkedinUrl: string | null;
};

/** Same stripping rule the tel: quick action uses in person-detail.tsx. */
const dialable = (v: string | null | undefined) => {
  const p = (v ?? "").replace(/[^+\d]/g, "");
  return /\d/.test(p) ? p : null;
};

export function outreachTarget(c: {
  emails: string[];
  phoneNumbers: string[];
  whatsappPhone?: string | null;
  linkedinUrl: string | null;
}): OutreachTarget {
  const phone = dialable(c.phoneNumbers[0]);
  return {
    email: c.emails[0]?.trim() || null,
    phone,
    whatsapp: dialable(c.whatsappPhone) ?? phone,
    linkedinUrl: c.linkedinUrl?.trim() || null,
  };
}

export function channelReady(ch: DraftChannel, t: OutreachTarget): boolean {
  if (ch === "email") return !!t.email;
  if (ch === "sms") return !!t.phone;
  if (ch === "whatsapp") return !!t.whatsapp;
  return !!t.linkedinUrl;
}

/** Interaction sources that correspond to a channel you can draft on. */
const SOURCE_CHANNEL: Partial<Record<InteractionSource, DraftChannel>> = {
  email: "email",
  messages: "sms",
  whatsapp: "whatsapp",
};

/** How far back "where you actually talk" looks. */
const OBSERVED_MONTHS = 6;

/**
 * The channel that carried the most messages with this person over the last
 * six months, from the monthly interaction buckets — or null when there's no
 * recent traffic on a draftable channel. This is what tells "texts on
 * iMessage" from "lives on WhatsApp" without anyone having to say so.
 */
export function observedChannel(
  periods: { source: InteractionSource; month: string; messageCount: number }[],
  now: Date = new Date(),
): DraftChannel | null {
  const since = new Date(now.getFullYear(), now.getMonth() - (OBSERVED_MONTHS - 1), 1);
  const cutoff = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-01`;
  const totals = new Map<DraftChannel, number>();
  for (const p of periods) {
    const ch = SOURCE_CHANNEL[p.source];
    if (!ch || p.month < cutoff) continue;
    totals.set(ch, (totals.get(ch) ?? 0) + p.messageCount);
  }
  let best: DraftChannel | null = null;
  for (const [ch, n] of totals) if (n > 0 && (!best || n > totals.get(best)!)) best = ch;
  return best;
}

export type ChannelChoice = {
  channel: DraftChannel;
  /** "preferred" = set by the owner; "observed" = most-used lately; "fallback" = first one on file. */
  basis: "preferred" | "observed" | "fallback";
};

/**
 * Which channel to reach someone on: the owner's stated preference when it's
 * sendable, else where you've actually been talking lately, else the first
 * channel with an identifier on file (email when none).
 */
export function chooseChannel(
  t: OutreachTarget,
  hint: { preferred?: DraftChannel | null; observed?: DraftChannel | null } = {},
): ChannelChoice {
  if (hint.preferred && channelReady(hint.preferred, t)) return { channel: hint.preferred, basis: "preferred" };
  if (hint.observed && channelReady(hint.observed, t)) return { channel: hint.observed, basis: "observed" };
  const channel: DraftChannel = t.email ? "email" : t.phone ? "sms" : t.linkedinUrl ? "linkedin" : "email";
  return { channel, basis: "fallback" };
}

/** chooseChannel(), channel only. */
export function defaultChannel(
  t: OutreachTarget,
  hint?: { preferred?: DraftChannel | null; observed?: DraftChannel | null },
): DraftChannel {
  return chooseChannel(t, hint).channel;
}

const MISSING: Record<DraftChannel, string> = {
  email: "No email address on file",
  sms: "No phone number on file",
  whatsapp: "No WhatsApp or phone number on file",
  linkedin: "No LinkedIn profile on file",
};

export type Handoff = {
  /** Null when the contact has no identifier for this channel. */
  url: string | null;
  /** "web" → open a new tab; "app" → navigate, so no about:blank is stranded. */
  scheme: "web" | "app";
  /** Always the full text. Every handoff copies; prefilling is the bonus. */
  copy: string;
  /** The body couldn't be prefilled — the user pastes it themselves. */
  needsPaste: boolean;
  label: string;
  /** Null whenever `url` is non-null. */
  reason: string | null;
};

/** The text put on the clipboard: subject and body for email, body alone otherwise. */
export function draftClipboardText(d: {
  channel: DraftChannel;
  subject: string | null;
  body: string;
}): string {
  if (d.channel === "email" && d.subject?.trim()) {
    return `${d.subject.trim()}\n\n${d.body}`;
  }
  return d.body;
}

export function buildHandoff(
  target: OutreachTarget,
  draft: { channel: DraftChannel; subject: string | null; body: string },
): Handoff {
  const { channel, body } = draft;
  const subject = draft.subject ?? "";
  const copy = draftClipboardText(draft);

  const blocked = (label: string): Handoff => ({
    url: null,
    scheme: "web",
    copy,
    needsPaste: true,
    label,
    reason: MISSING[channel],
  });

  if (channel === "linkedin") {
    // LinkedIn has no public URL that populates a message box. The documented
    // /messaging/thread/new form takes an internal member URN, not the vanity
    // slug stored in contacts.linkedin_url. So this always ends in a paste.
    if (!target.linkedinUrl) return blocked("Open LinkedIn");
    return {
      url: target.linkedinUrl,
      scheme: "web",
      copy,
      needsPaste: true,
      label: "Copy & open LinkedIn",
      reason: null,
    };
  }

  if (channel === "whatsapp") {
    if (!target.whatsapp) return blocked("Open WhatsApp");
    // whatsapp://send opens the installed app (Mac and iPhone) straight into
    // the chat with the text prefilled; wa.me would detour through a browser
    // landing page first. The number goes in digits only, no "+".
    const base = `whatsapp://send?phone=${target.whatsapp.replace(/\D/g, "")}`;
    const full = `${base}&text=${q(body)}`;
    const fits = full.length <= MAX_URL;
    return {
      url: fits ? full : base,
      scheme: "app",
      copy,
      needsPaste: !fits,
      label: "Open WhatsApp",
      reason: null,
    };
  }

  if (channel === "sms") {
    if (!target.phone) return blocked("Open Messages");
    // Apple's Messages parses the "&body=" form; "?body=" is the Android/RFC
    // 5724 spelling and has historically been ignored here. This app runs on
    // the user's Mac and iPhone, so "&" is the correct choice — don't
    // "standardize" it without testing on Messages first.
    const base = `sms:${target.phone}`;
    const full = `${base}&body=${q(body)}`;
    const fits = full.length <= MAX_URL;
    return {
      url: fits ? full : base,
      scheme: "app",
      copy,
      needsPaste: !fits,
      label: "Open Messages",
      reason: null,
    };
  }

  if (!target.email) return blocked("Open in Gmail");
  // The address is intentionally not encoded: encodeURIComponent turns "@" into
  // "%40", which some handlers drop into the To field verbatim. Contact emails
  // here are plain ASCII addresses.
  const base = `https://mail.google.com/mail/?view=cm&fs=1&to=${target.email}&su=${q(subject)}`;
  const full = `${base}&body=${q(body)}`;
  const fits = full.length <= MAX_URL;
  return {
    // Over the cap, still open compose with To and Subject filled so there's
    // exactly one thing left to paste. Never truncate the body.
    url: fits ? full : base,
    scheme: "web",
    copy,
    needsPaste: !fits,
    label: "Open in Gmail",
    reason: null,
  };
}
