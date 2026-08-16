/**
 * X API v2 client: posting (free tier is ~500 writes/month) plus the two
 * signed reads the weekly metrics job needs (src/lib/jobs/x-metrics.ts).
 *
 * Auth is OAuth 1.0a user context with the four static values the X developer
 * portal generates under "Keys and tokens". Chosen over OAuth2 PKCE on
 * purpose: PKCE refresh tokens are single-use and rotate on every refresh,
 * which is hostile to immutable Vercel env vars; the 1.0a values never expire,
 * so posting works as a plain server action from any device.
 *
 * Portal gotcha: the app must be set to "Read and write" BEFORE generating
 * the access token — tokens minted under read-only keep read-only forever
 * and every post 403s until they're regenerated.
 *
 * Pure module (not "use server"), hand-rolled signer over node:crypto — the
 * usual libraries are unmaintained and it's ~40 lines of RFC 5849.
 */

import { createHmac } from "node:crypto";
import { getSecrets } from "@/lib/secrets";

const TWEETS_URL = "https://api.x.com/2/tweets";

type XKeys = {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
};

/** One DB round trip for all four — each can come from Setup or from env. */
async function keys(): Promise<XKeys | null> {
  const v = await getSecrets(
    "X_API_KEY",
    "X_API_SECRET",
    "X_ACCESS_TOKEN",
    "X_ACCESS_SECRET",
  );
  if (!v.X_API_KEY || !v.X_API_SECRET || !v.X_ACCESS_TOKEN || !v.X_ACCESS_SECRET) {
    return null;
  }
  return {
    apiKey: v.X_API_KEY,
    apiSecret: v.X_API_SECRET,
    accessToken: v.X_ACCESS_TOKEN,
    accessSecret: v.X_ACCESS_SECRET,
  };
}

/**
 * RFC 3986 percent-encoding. encodeURIComponent leaves !'()* unescaped, which
 * is exactly the set OAuth 1.0a signatures require escaped — miss one and the
 * signature check fails only on posts containing those characters, a bug that
 * hides until someone tweets an apostrophe.
 */
function pct(v: string): string {
  return encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * OAuth 1.0a Authorization header. `query` holds the request's query-string
 * params: per RFC 5849 §3.4.1.3 they join the oauth_* params in the signature
 * base string (sorted together), while a JSON body — what the POST /2/tweets
 * call sends — is excluded. The signed URL must be the bare URL without the
 * query; the caller appends the same params when it actually fetches.
 */
function authHeader(
  method: "GET" | "POST",
  url: string,
  k: XKeys,
  query: Record<string, string> = {},
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: k.apiKey,
    oauth_nonce: Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join(""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: k.accessToken,
    oauth_version: "1.0",
  };

  const all: Record<string, string> = { ...query, ...oauth };
  const paramString = Object.keys(all)
    .sort()
    .map((key) => `${pct(key)}=${pct(all[key])}`)
    .join("&");
  const base = [method, pct(url), pct(paramString)].join("&");
  const signingKey = `${pct(k.apiSecret)}&${pct(k.accessSecret)}`;
  oauth.oauth_signature = createHmac("sha1", signingKey)
    .update(base)
    .digest("base64");

  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((key) => `${pct(key)}="${pct(oauth[key])}"`)
      .join(", ")
  );
}

export type PostTweetResult =
  | { ok: true; id: string; url: string }
  | { ok: false; error: string };

export async function postTweet(body: string): Promise<PostTweetResult> {
  const k = await keys();
  if (!k) return { ok: false, error: "X API keys are not configured." };
  const text = body.trim();
  if (!text) return { ok: false, error: "Nothing to post." };

  let res: Response;
  try {
    res = await fetch(TWEETS_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader("POST", TWEETS_URL, k),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, error: "Couldn't reach X. Try again." };
  }

  if (res.status === 401) {
    return { ok: false, error: "X rejected the API keys. Check all four values." };
  }
  if (res.status === 403) {
    return {
      ok: false,
      error:
        "X refused the post (403). If the app was ever read-only, regenerate the access token under Read and write. Duplicate text also 403s.",
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      error: "X rate limit hit — the free tier allows ~500 posts a month.",
    };
  }
  if (!res.ok) {
    return { ok: false, error: `X returned ${res.status}.` };
  }

  const json = (await res.json()) as { data?: { id?: string } };
  const id = json.data?.id;
  if (!id) return { ok: false, error: "X returned no tweet id." };

  // /i/status/<id> resolves without knowing the handle — it redirects to the
  // canonical /<handle>/status/<id> when opened.
  return { ok: true, id, url: `https://x.com/i/status/${id}` };
}

export type XGetResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /**
       * "unconfigured" — no keys; "unauthorized" — keys rejected;
       * "forbidden" — the access tier doesn't include this read (X's free
       * tier is write-heavy and read-poor); "rate_limited"; "error".
       */
      reason: "unconfigured" | "unauthorized" | "forbidden" | "rate_limited" | "error";
      status?: number;
      error: string;
    };

/**
 * Signed GET against the v2 API, user context — used by the metrics job for
 * users/me and the own-tweets timeline. Reads are metered per 15-minute
 * window and per month on the free tier, so callers keep it to a handful of
 * requests per run.
 */
export async function xGet<T>(
  path: string,
  query: Record<string, string>,
): Promise<XGetResult<T>> {
  const k = await keys();
  if (!k) return { ok: false, reason: "unconfigured", error: "X API keys are not configured." };
  const url = `https://api.x.com/2${path}`;
  const qs = new URLSearchParams(query).toString();
  let res: Response;
  try {
    res = await fetch(qs ? `${url}?${qs}` : url, {
      headers: { Authorization: authHeader("GET", url, k, query) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, reason: "error", error: "Couldn't reach X." };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized", status: 401, error: "X rejected the API keys." };
  }
  if (res.status === 402 || res.status === 403) {
    return {
      ok: false,
      reason: "forbidden",
      status: res.status,
      error: `X refused the read (${res.status}) — this endpoint isn't included in the app's access tier.`,
    };
  }
  if (res.status === 429) {
    return { ok: false, reason: "rate_limited", status: 429, error: "X rate limit hit." };
  }
  if (!res.ok) {
    return { ok: false, reason: "error", status: res.status, error: `X returned ${res.status}.` };
  }
  return { ok: true, data: (await res.json()) as T };
}
