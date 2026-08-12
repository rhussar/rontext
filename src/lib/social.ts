import type { SocialPostPlatform } from "@/db/schema";

/**
 * Handoff links for publishing social posts, sibling of outreach.ts and under
 * the same philosophy: every handoff copies the full text to the clipboard;
 * prefilling the platform's composer is a bonus, never load-bearing.
 */

export const PLATFORM_LABELS: Record<SocialPostPlatform, string> = {
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
};

/**
 * Platform caps for the composer's live counter. X's is the only hard one a
 * post routinely hits; LinkedIn and Instagram caps exist but are roomy.
 */
export const PLATFORM_CHAR_LIMITS: Record<SocialPostPlatform, number> = {
  x: 280,
  linkedin: 3000,
  instagram: 2200,
};

/**
 * Same cap and reasoning as outreach.ts: URL handlers truncate over-long URLs
 * silently, so past this we open the bare composer and rely on the paste.
 */
const MAX_URL = 1800;

/**
 * encodeURIComponent, never URLSearchParams — URLSearchParams encodes a space
 * as "+", which x.com's intent page renders literally. Same bug family as the
 * mailto:/sms: case documented in outreach.ts.
 */
const q = (v: string) => encodeURIComponent(v);

/**
 * Strip query string and trailing slash, canonicalize twitter.com → x.com.
 * Scraper URLs, hand-pasted permalinks and API-returned URLs all go through
 * this, so the postUrl join between social_posts and social_post_metrics
 * stays exact.
 */
export function normalizePostUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const host = u.hostname
      .replace(/^www\./, "")
      .replace(/^(mobile\.)?twitter\.com$/, "x.com");
    return `https://${host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed;
  }
}

/**
 * Platforms with an identity record (photo, name, handle, bio) editable in
 * Settings → General. Lives here, not in actions/social.ts, because a
 * "use server" module can only export async functions. YouTube is identity
 * storage only until the app grows a YouTube feature.
 */
export const PROFILE_PLATFORMS = ["linkedin", "x", "instagram", "youtube"] as const;
export type ProfilePlatform = (typeof PROFILE_PLATFORMS)[number];

export type PlatformProfile = {
  name: string;
  /** Stored without the @. */
  handle: string;
  /** LinkedIn calls this the headline; everywhere else it's a bio. */
  bio: string;
  /** Data URL, or null for the initials circle. */
  avatar: string | null;
};

export type PostHandoff = {
  url: string;
  /** Always the full body. Every handoff copies; prefilling is the bonus. */
  copy: string;
  /** The composer couldn't be prefilled — the user pastes it themselves. */
  needsPaste: boolean;
  label: string;
};

/**
 * X counts every URL as 23 characters (t.co wrapping) regardless of its real
 * length, so a plain .length is only exact for URL-free posts. The counter
 * labels itself "approx" when this returns { approx: true }.
 */
export function platformCharCount(
  platform: SocialPostPlatform,
  body: string,
): { count: number; limit: number; approx: boolean } {
  const limit = PLATFORM_CHAR_LIMITS[platform];
  const hasUrl = /https?:\/\/\S+/.test(body);
  if (platform === "x" && hasUrl) {
    const count = body.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;
    return { count, limit, approx: true };
  }
  return { count: body.length, limit, approx: false };
}

export function buildPostHandoff(
  platform: SocialPostPlatform,
  body: string,
): PostHandoff {
  if (platform === "x") {
    const full = `https://x.com/intent/post?text=${q(body)}`;
    const fits = full.length <= MAX_URL;
    return {
      // Over the cap, open the bare composer — never truncate the body.
      url: fits ? full : "https://x.com/compose/post",
      copy: body,
      needsPaste: !fits,
      label: "Open X composer",
    };
  }

  if (platform === "linkedin") {
    // shareActive=true&text= opens the feed's start-a-post box prefilled. The
    // param is UNOFFICIAL — LinkedIn documents no such URL — so needsPaste
    // stays true on purpose: the copy already happened, and if LinkedIn drops
    // the param the user just pastes without ever noticing a breakage. Don't
    // "fix" this to needsPaste: false.
    const full = `https://www.linkedin.com/feed/?shareActive=true&text=${q(body)}`;
    const fits = full.length <= MAX_URL;
    return {
      url: fits ? full : "https://www.linkedin.com/feed/?shareActive=true",
      copy: body,
      needsPaste: true,
      label: "Copy & open LinkedIn",
    };
  }

  // Instagram has no web composer that accepts a prefilled caption at all —
  // feed posts start from the app or instagram.com's create flow. Pure paste.
  return {
    url: "https://www.instagram.com/",
    copy: body,
    needsPaste: true,
    label: "Copy caption & open Instagram",
  };
}
