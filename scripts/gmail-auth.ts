/**
 * Gmail credentials, stored on this Mac only.
 *
 * The refresh token lives in ~/.mesh-replica/gmail.json at mode 0600 — never in
 * Postgres, never on Vercel, never in the repo. That keeps the property the
 * whole app relies on: nothing in the database is a secret, so there is nothing
 * to encrypt at rest and nothing to leak if the passcode is guessed.
 *
 * Plain fetch against Google's REST endpoints rather than the `googleapis`
 * package — this is two HTTP calls, and that dependency is enormous.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOKEN_PATH = join(
  process.env.HOME ?? "",
  ".mesh-replica",
  "gmail.json",
);

/** Read-only. The connector never needs to send, modify or delete anything. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export type GmailCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The Google account this was paired with, for the "who am I" line. */
  emailAddress?: string;
};

export function loadCredentials(): GmailCredentials | null {
  if (!existsSync(TOKEN_PATH)) return null;
  return JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as GmailCredentials;
}

export function saveCredentials(creds: GmailCredentials): void {
  mkdirSync(dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(TOKEN_PATH, 0o600); // explicit — writeFileSync honours umask
}

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 *
 * If this starts failing with invalid_grant, the OAuth app is probably still in
 * "Testing" publishing status — Google expires refresh tokens for restricted
 * scopes after 7 days there. Publishing the app (unverified is fine for
 * personal use) makes them durable.
 */
export async function getAccessToken(creds: GmailCredentials): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Token refresh failed (${res.status}): ${body.error ?? "unknown"}. ` +
        `Re-pair with: npx tsx scripts/pair-gmail.ts`,
    );
  }
  return body.access_token;
}

/** GET a Gmail REST endpoint, retrying once on a rate-limit or 5xx. */
export async function gmailGet<T>(
  accessToken: string,
  path: string,
  params: Record<string, string | string[]> = {},
): Promise<T> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  for (const [k, v] of Object.entries(params)) {
    for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    throw new Error(`Gmail ${path} failed (${res.status}): ${await res.text()}`);
  }
  throw new Error(`Gmail ${path} failed after retries`);
}
