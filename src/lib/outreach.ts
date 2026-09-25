import type { DraftChannel } from "@/db/schema";

export const CHANNEL_LABELS: Record<DraftChannel, string> = {
  email: "Email",
  sms: "Text",
  linkedin: "LinkedIn",
};

/** Article included — "a"/"an" can't be derived from the label ("an email", "a text"). */
export const CHANNEL_PHRASES: Record<DraftChannel, string> = {
  email: "an email",
  sms: "a text",
  linkedin: "a LinkedIn message",
};

/** Past tense, for the timeline row a draft becomes once it's been sent. */
export const CHANNEL_SENT_LABELS: Record<DraftChannel, string> = {
  email: "Sent an email",
  sms: "Sent a text",
  linkedin: "Sent a LinkedIn message",
};

/**
 * mailto: and sms: are handed straight to the OS URL handler, which truncates
 * an over-long URL silently rather than erroring — a half-written message would
 * open with no warning. 1800 sits under the smallest limit anything in this
 * chain enforces. Gmail's https compose tolerates more but also drops very long
 * `body` params, so one cap covers all three.
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
  linkedinUrl: string | null;
};

export function outreachTarget(c: {
  emails: string[];
  phoneNumbers: string[];
  linkedinUrl: string | null;
}): OutreachTarget {
  // Same stripping rule the tel: quick action uses in person-detail.tsx.
  const phone = (c.phoneNumbers[0] ?? "").replace(/[^+\d]/g, "");
  return {
    email: c.emails[0]?.trim() || null,
    phone: /\d/.test(phone) ? phone : null,
    linkedinUrl: c.linkedinUrl?.trim() || null,
  };
}

export function channelReady(ch: DraftChannel, t: OutreachTarget): boolean {
  if (ch === "email") return !!t.email;
  if (ch === "sms") return !!t.phone;
  return !!t.linkedinUrl;
}

/** First channel this person is actually reachable on; email when none. */
export function defaultChannel(t: OutreachTarget): DraftChannel {
  if (t.email) return "email";
  if (t.phone) return "sms";
  if (t.linkedinUrl) return "linkedin";
  return "email";
}

const MISSING: Record<DraftChannel, string> = {
  email: "No email address on file",
  sms: "No phone number on file",
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
  /** What the toast says after the handoff, when the generic line would mislead. */
  hint?: string;
};

/**
 * Where an email draft already lives in Gmail, if an agent put it there: a
 * real Gmail draft replying in the thread, and/or the thread itself.
 * `edited` = the owner changed the text in Rontext after the agent wrote
 * both copies, so the Gmail draft no longer matches.
 */
export type GmailLink = {
  gmailDraftUrl?: string | null;
  emailThreadUrl?: string | null;
  edited?: boolean;
};

/**
 * Only ever hand the browser a Gmail URL. These arrive from an agent over MCP
 * and are checked on the way in too; checking again here means a bad row can
 * never turn the Gmail button into a link somewhere else.
 */
export function isGmailUrl(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "mail.google.com";
  } catch {
    return false;
  }
}

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
  draft: { channel: DraftChannel; subject: string | null; body: string } & GmailLink,
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

  // A reply an agent already wrote into the thread as a Gmail draft: open
  // that draft rather than a blank compose, so it goes out threaded, with the
  // quoted history, to the right people.
  if (isGmailUrl(draft.gmailDraftUrl)) {
    return {
      url: draft.gmailDraftUrl,
      scheme: "web",
      // Body only, here and for the thread below: the reply already has its
      // subject, and a pasted "Re: …" line would land in the message itself.
      copy: draft.body,
      needsPaste: !!draft.edited,
      label: "Open Gmail draft",
      reason: null,
      hint: draft.edited
        ? "Your edits are copied. Paste them over the Gmail draft"
        : "Opened your reply in the Gmail thread",
    };
  }
  // No Gmail draft, but we know the thread: open it and reply there, so the
  // message stays in the conversation instead of starting a new one.
  if (isGmailUrl(draft.emailThreadUrl)) {
    return {
      url: draft.emailThreadUrl,
      scheme: "web",
      copy: draft.body,
      needsPaste: true,
      label: "Reply in Gmail",
      reason: null,
      hint: "Copied. Hit Reply in the thread and paste",
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
