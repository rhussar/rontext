/**
 * Gmail credentials on this Mac — the file-based store used by pair-gmail.ts
 * and, as a fallback, by ingest-gmail.ts.
 *
 * The app now has its own store (src/lib/google-auth.ts: the write-only
 * secret rows in app_state, filled by Settings → Accounts → Connect Google or
 * by scripts/migrate-gmail-token.ts). That's what the daily cron job reads.
 * This file remains for the CLI path and for machines that paired before the
 * in-app flow existed. Token refresh and the HTTP helper are the lib's.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GMAIL_API, googleGet, refreshAccessToken } from "../src/lib/google-auth";

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

/** Exchange the refresh token for an access token — see src/lib/google-auth.ts. */
export async function getAccessToken(creds: GmailCredentials): Promise<string> {
  return refreshAccessToken(creds);
}

/** GET a Gmail REST endpoint (users/me/<path>), retrying on rate-limit or 5xx. */
export async function gmailGet<T>(
  accessToken: string,
  path: string,
  params: Record<string, string | string[]> = {},
): Promise<T> {
  return googleGet<T>(accessToken, `${GMAIL_API}/${path}`, params);
}
