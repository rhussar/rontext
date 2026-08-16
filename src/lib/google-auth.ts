/**
 * Google credentials for the app — the server-side successor to
 * ~/.mesh-replica/gmail.json.
 *
 * Three pieces, all in app_state through the same write-only secret store the
 * Setup panel uses (`secret:<NAME>`, DB wins over env, never read back to a
 * client):
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — the OAuth client, pasted in Setup
 *   GOOGLE_REFRESH_TOKEN                    — minted by /api/oauth/google/callback
 * plus two non-secret facts under plain keys: `google:email` (which account)
 * and `google:scopes` (what was granted — the jobs check this so a token
 * paired for Gmail alone doesn't try to read Contacts and 403).
 *
 * Read-only scopes only, ever: the connectors count and match, nothing sends,
 * edits or deletes on the Google side. That's enforced by the scope list here
 * — a job can't do what the token can't.
 *
 * Pure module (not "use server"): it returns secret material, so it must have
 * no client-callable surface. Plain fetch, no googleapis — three endpoints.
 */
import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { appState } from "@/db/schema";
import { getSecrets, secretStorageKey } from "@/lib/secrets";

export const GOOGLE_SCOPES = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
} as const;
export type GoogleScopeKey = keyof typeof GOOGLE_SCOPES;

const EMAIL_KEY = "google:email";
const SCOPES_KEY = "google:scopes";
const CONNECTED_AT_KEY = "google:connectedAt";
/**
 * "desktop" = migrated from the Mac pairing (a Desktop OAuth client, which
 * Google won't redirect to an https callback), "web" = minted by the in-app
 * flow. Plus the client id the token was minted under, so we can tell when a
 * *different* (Web) client has been pasted into Setup and Connect can work.
 */
const CLIENT_TYPE_KEY = "google:clientType";
const TOKEN_CLIENT_ID_KEY = "google:tokenClientId";
const META_KEYS = [EMAIL_KEY, SCOPES_KEY, CONNECTED_AT_KEY, CLIENT_TYPE_KEY, TOKEN_CLIENT_ID_KEY];

export type GoogleCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  email: string | null;
  /** Granted scope URLs. Empty when unknown (pre-migration tokens). */
  scopes: string[];
  connectedAt: string | null;
  clientType: "desktop" | "web";
  /** Client id the refresh token was minted under. */
  tokenClientId: string | null;
};

/** The OAuth client alone — enough to *start* a connect flow. */
export async function getGoogleClient(): Promise<{ clientId: string; clientSecret: string } | null> {
  const v = await getSecrets("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
  if (!v.GOOGLE_CLIENT_ID || !v.GOOGLE_CLIENT_SECRET) return null;
  return { clientId: v.GOOGLE_CLIENT_ID, clientSecret: v.GOOGLE_CLIENT_SECRET };
}

export async function getGoogleCredentials(): Promise<GoogleCredentials | null> {
  const [v, meta] = await Promise.all([
    getSecrets("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"),
    getDb()
      .select({ key: appState.key, value: appState.value })
      .from(appState)
      .where(inArray(appState.key, META_KEYS)),
  ]);
  if (!v.GOOGLE_CLIENT_ID || !v.GOOGLE_CLIENT_SECRET || !v.GOOGLE_REFRESH_TOKEN) return null;
  const m = new Map(meta.map((r) => [r.key, r.value]));
  return {
    clientId: v.GOOGLE_CLIENT_ID,
    clientSecret: v.GOOGLE_CLIENT_SECRET,
    refreshToken: v.GOOGLE_REFRESH_TOKEN,
    email: m.get(EMAIL_KEY)?.toLowerCase() || null,
    scopes: (m.get(SCOPES_KEY) ?? "").split(/\s+/).filter(Boolean),
    connectedAt: m.get(CONNECTED_AT_KEY) || null,
    clientType: m.get(CLIENT_TYPE_KEY) === "desktop" ? "desktop" : "web",
    tokenClientId: m.get(TOKEN_CLIENT_ID_KEY) || null,
  };
}

/** Does the stored grant include this scope? Unknown (empty) counts as gmail-only. */
export function hasScope(creds: GoogleCredentials, key: GoogleScopeKey): boolean {
  if (creds.scopes.length === 0) return key === "gmail";
  return creds.scopes.includes(GOOGLE_SCOPES[key]);
}

/**
 * Persist a fresh grant. Called by the OAuth callback and by the one-time
 * migration from the Mac token file. Client id/secret are written too so a
 * migrated Desktop-client token keeps refreshing with the client it was
 * minted under, even before a Web client is pasted into Setup.
 */
export async function saveGoogleGrant(grant: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  email: string | null;
  scopes: string[];
  clientType: "desktop" | "web";
}): Promise<void> {
  const now = new Date();
  const rows = [
    { key: secretStorageKey("GOOGLE_CLIENT_ID"), value: grant.clientId },
    { key: secretStorageKey("GOOGLE_CLIENT_SECRET"), value: grant.clientSecret },
    { key: secretStorageKey("GOOGLE_REFRESH_TOKEN"), value: grant.refreshToken },
    { key: EMAIL_KEY, value: grant.email ?? "" },
    { key: SCOPES_KEY, value: grant.scopes.join(" ") },
    { key: CONNECTED_AT_KEY, value: now.toISOString() },
    { key: CLIENT_TYPE_KEY, value: grant.clientType },
    { key: TOKEN_CLIENT_ID_KEY, value: grant.clientId },
  ];
  const db = getDb();
  for (const r of rows) {
    await db
      .insert(appState)
      .values({ ...r, updatedAt: now })
      .onConflictDoUpdate({ target: appState.key, set: { value: r.value, updatedAt: now } });
  }
}

/**
 * Forget the grant. Best-effort revoke at Google first so the token is dead
 * everywhere, not just here; the local delete happens regardless. The client
 * id/secret stay — they're Setup keys, and the next Connect reuses them.
 */
export async function clearGoogleGrant(): Promise<void> {
  const creds = await getGoogleCredentials();
  if (creds) {
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: creds.refreshToken }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Unreachable Google shouldn't stop a disconnect.
    }
  }
  const db = getDb();
  await db
    .delete(appState)
    .where(inArray(appState.key, [secretStorageKey("GOOGLE_REFRESH_TOKEN"), ...META_KEYS]));
}

/** Non-secret connection facts for the Accounts card. */
export async function getGoogleConnection(): Promise<{
  connected: boolean;
  /**
   * Whether "Connect Google" can work: a client is in Setup and it isn't the
   * migrated Desktop one (which Google refuses to redirect to a web callback).
   * A *different* client id than the token's means a Web client was pasted —
   * that's the signal to offer Connect even while a desktop grant is live.
   */
  canConnect: boolean;
  clientConfigured: boolean;
  clientType: "desktop" | "web" | null;
  email: string | null;
  scopes: GoogleScopeKey[];
  connectedAt: string | null;
}> {
  const [creds, client] = await Promise.all([getGoogleCredentials(), getGoogleClient()]);
  if (creds) {
    const differentClient = !!creds.tokenClientId && creds.tokenClientId !== creds.clientId;
    return {
      connected: true,
      canConnect: creds.clientType === "web" || differentClient,
      clientConfigured: true,
      clientType: creds.clientType,
      email: creds.email,
      scopes: (Object.keys(GOOGLE_SCOPES) as GoogleScopeKey[]).filter((k) => hasScope(creds, k)),
      connectedAt: creds.connectedAt,
    };
  }
  return {
    connected: false,
    canConnect: !!client,
    clientConfigured: !!client,
    clientType: null,
    email: null,
    scopes: [],
    connectedAt: null,
  };
}

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 *
 * invalid_grant here usually means the OAuth app is in "Testing" publishing
 * status — Google expires refresh tokens for restricted scopes after 7 days
 * there — or the user revoked access. Either way: reconnect from Settings.
 */
export async function refreshAccessToken(creds: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Google token refresh failed (${res.status}): ${body.error ?? "unknown"} — reconnect Google in Settings → Accounts`,
    );
  }
  return body.access_token;
}

/** GET a Google REST endpoint, retrying on rate-limit or 5xx. */
export async function googleGet<T>(
  accessToken: string,
  url: string,
  params: Record<string, string | string[]> = {},
): Promise<T> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    for (const one of Array.isArray(v) ? v : [v]) u.searchParams.append(k, one);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(u, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    // Trim so a 403 body can't smuggle a novel into job_runs.message.
    throw new Error(`Google ${u.pathname} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`Google ${u.pathname} failed after retries`);
}

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const PEOPLE_API = "https://people.googleapis.com/v1";
export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Which account a token belongs to — Gmail's profile call, no extra scope needed. */
export async function fetchGmailAddress(accessToken: string): Promise<string | null> {
  try {
    const p = await googleGet<{ emailAddress?: string }>(accessToken, `${GMAIL_API}/profile`);
    return p.emailAddress?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
