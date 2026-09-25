/**
 * The OAuth 2.1 authorization server behind "Add custom connector" on
 * claude.ai — how a cloud agent (a Routine, a claude.ai chat) gets its own
 * Rontext identity without anyone pasting a token.
 *
 * The flow, all standard (the MCP authorization spec):
 *  1. The client calls /api/mcp with no token and gets a 401 naming
 *     /.well-known/oauth-protected-resource, which names this server.
 *  2. It reads /.well-known/oauth-authorization-server and registers itself
 *     (RFC 7591 dynamic client registration) — which grants nothing.
 *  3. It sends the owner's browser to /oauth/authorize. That page sits behind
 *     the passcode; the owner names the agent, picks read or read+write, and
 *     approves. Approval creates (or reuses) an `mcp_agents` identity.
 *  4. The client swaps the one-time code (PKCE S256 required) for a one-hour
 *     access token and a refresh token, both rows in `mcp_tokens` for that
 *     agent — so a connector is revoked, scoped and audited exactly like a
 *     static token.
 *
 * Refresh tokens rotate on every use. Presenting one that was already
 * rotated away means two parties hold it — the classic sign of a stolen
 * token — so every token that agent holds through that client is revoked.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { mcpAgents, mcpOauthClients, mcpOauthCodes, mcpTokens, type McpAccess } from "@/db/schema";
import { AGENT_KEY_RE, hashSecret, newSecret, secretHint } from "@/lib/mcp-auth";

export const ACCESS_TOKEN_TTL_S = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 90 * 86_400_000;
const CODE_TTL_MS = 10 * 60_000;
const REUSE_GRACE_MS = 30_000;
export const OAUTH_SCOPES = ["read", "write"] as const;

/* ------------------------------------------------------------------ *
 * Metadata
 * ------------------------------------------------------------------ */

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/mcp/token`,
    registration_endpoint: `${origin}/api/oauth/mcp/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...OAUTH_SCOPES],
  };
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Rontext",
  };
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class OAuthFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
  toJSON() {
    return { error: this.code, error_description: this.message };
  }
}

/* ------------------------------------------------------------------ *
 * Client registration (RFC 7591)
 * ------------------------------------------------------------------ */

/**
 * https anywhere, or http only on loopback (local MCP clients). No custom
 * schemes and no fragments — a redirect URI is where an authorization code
 * goes, so it has to be somewhere a stranger can't sit.
 */
export function acceptableRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export async function registerClient(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const redirectUris = b.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > 10 ||
    !redirectUris.every((u) => typeof u === "string" && u.length <= 2_000 && acceptableRedirectUri(u))
  ) {
    throw new OAuthFailure(
      "invalid_redirect_uri",
      "redirect_uris must be 1-10 https URLs (http only for localhost)",
    );
  }
  const method = typeof b.token_endpoint_auth_method === "string" ? b.token_endpoint_auth_method : "none";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
    throw new OAuthFailure("invalid_client_metadata", `Unsupported token_endpoint_auth_method ${method}`);
  }
  const name =
    typeof b.client_name === "string" && b.client_name.trim()
      ? b.client_name.trim().slice(0, 100)
      : "Unnamed MCP client";

  const clientId = newSecret("rtxs").replace(/^rtxs_/, "mcp_").slice(0, 36);
  const secret = method === "none" ? null : newSecret("rtxs");
  await getDb()
    .insert(mcpOauthClients)
    .values({
      clientId,
      name,
      redirectUris: redirectUris as string[],
      secretHash: secret ? hashSecret(secret) : null,
    });

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Authorization request
 * ------------------------------------------------------------------ */

/** The authorization-request parameters the consent form carries through. */
export const AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

export type AuthorizeRequest = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  /** What the client asked for; the owner can grant less. */
  requestedAccess: McpAccess;
};

/**
 * Validates /oauth/authorize parameters. Two failure kinds, per RFC 6749
 * §4.1.2.1: if the client or redirect URI is bad, the error must be shown to
 * the owner and NOT redirected (redirecting to an unverified URI is how codes
 * get stolen); anything else is sent back to the client's redirect URI.
 */
export async function validateAuthorizeRequest(
  params: Record<string, string | undefined>,
): Promise<
  | { ok: true; req: AuthorizeRequest }
  | { ok: false; show: string }
  | { ok: false; redirect: string }
> {
  const clientId = params.client_id ?? "";
  const redirectUri = params.redirect_uri ?? "";
  const [client] = clientId
    ? await getDb().select().from(mcpOauthClients).where(eq(mcpOauthClients.clientId, clientId))
    : [];
  if (!client) return { ok: false, show: "This connector isn't registered with Rontext. Try adding it again." };
  if (!client.redirectUris.includes(redirectUri)) {
    return { ok: false, show: "The connector asked to send you somewhere it didn't register. Nothing was shared." };
  }

  const state = params.state ?? null;
  const back = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    return { ok: false as const, redirect: u.toString() };
  };
  if (params.response_type !== "code") return back("unsupported_response_type", "Only response_type=code");
  if (!params.code_challenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_challenge)) {
    return back("invalid_request", "PKCE code_challenge required");
  }
  if (params.code_challenge_method !== "S256") {
    return back("invalid_request", "code_challenge_method must be S256");
  }
  const scopes = (params.scope ?? "").split(/\s+/).filter(Boolean);
  // No scope asked = read + write, which is what an MCP client that doesn't
  // know about scopes expects; the owner still chooses on the consent page.
  const requestedAccess: McpAccess = scopes.length && !scopes.includes("write") ? "read" : "write";

  return {
    ok: true,
    req: {
      clientId,
      clientName: client.name,
      redirectUri,
      codeChallenge: params.code_challenge,
      state,
      requestedAccess,
    },
  };
}

/** A sensible default key for the consent form: "Claude" → "claude". */
export function suggestAgentKey(clientName: string): string {
  const slug = clientName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return AGENT_KEY_RE.test(slug) ? slug : "claude-connector";
}

/**
 * The owner approved: find or create the agent, mint a code, and return the
 * URL to send the browser to. Reusing an existing live agent keeps its access
 * and allowlist — the consent page can create identities, not quietly widen
 * one set up in Settings.
 */
export async function approveAuthorization(
  req: AuthorizeRequest,
  choice: { agentKey: string; access: McpAccess },
): Promise<string> {
  if (!AGENT_KEY_RE.test(choice.agentKey)) {
    throw new OAuthFailure("invalid_request", "Agent name must be lowercase letters, digits and dashes");
  }
  const db = getDb();
  const [existing] = await db.select().from(mcpAgents).where(eq(mcpAgents.key, choice.agentKey));
  if (existing?.revokedAt) {
    throw new OAuthFailure("invalid_request", `"${choice.agentKey}" was revoked — pick a new name`);
  }
  const agent =
    existing ??
    (
      await db
        .insert(mcpAgents)
        .values({ key: choice.agentKey, access: choice.access, note: `Connected via ${req.clientName}` })
        .returning()
    )[0];

  const code = newSecret("rtxc");
  await db.insert(mcpOauthCodes).values({
    codeHash: hashSecret(code),
    clientId: req.clientId,
    agentId: agent.id,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  const u = new URL(req.redirectUri);
  u.searchParams.set("code", code);
  if (req.state) u.searchParams.set("state", req.state);
  return u.toString();
}

export function denyAuthorization(req: AuthorizeRequest): string {
  const u = new URL(req.redirectUri);
  u.searchParams.set("error", "access_denied");
  u.searchParams.set("error_description", "The owner declined");
  if (req.state) u.searchParams.set("state", req.state);
  return u.toString();
}

/* ------------------------------------------------------------------ *
 * Token endpoint
 * ------------------------------------------------------------------ */

type TokenRequest = Record<string, string | undefined>;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Public clients prove nothing here (PKCE does that); confidential ones must present their secret. */
async function authenticateClient(p: TokenRequest, basic: { id: string; secret: string } | null) {
  const clientId = basic?.id ?? p.client_id ?? "";
  const [client] = clientId
    ? await getDb().select().from(mcpOauthClients).where(eq(mcpOauthClients.clientId, clientId))
    : [];
  if (!client) throw new OAuthFailure("invalid_client", "Unknown client", 401);
  if (client.secretHash) {
    const secret = basic?.secret ?? p.client_secret ?? "";
    if (!secret || !safeEqual(hashSecret(secret), client.secretHash)) {
      throw new OAuthFailure("invalid_client", "Bad client credentials", 401);
    }
  }
  return client;
}

async function issueTokens(agentId: number, clientId: string, access: McpAccess) {
  const accessToken = newSecret("rtxa");
  const refreshToken = newSecret("rtxr");
  await getDb()
    .insert(mcpTokens)
    .values([
      {
        agentId,
        kind: "access",
        tokenHash: hashSecret(accessToken),
        hint: secretHint(accessToken),
        clientId,
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_S * 1000),
      },
      {
        agentId,
        kind: "refresh",
        tokenHash: hashSecret(refreshToken),
        hint: secretHint(refreshToken),
        clientId,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    ]);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refreshToken,
    scope: access === "write" ? "read write" : "read",
  };
}

export async function tokenRequest(p: TokenRequest, basic: { id: string; secret: string } | null) {
  const client = await authenticateClient(p, basic);
  const db = getDb();

  if (p.grant_type === "authorization_code") {
    if (!p.code || !p.code_verifier) {
      throw new OAuthFailure("invalid_request", "code and code_verifier are required");
    }
    // Claim the code in one statement, so two racing exchanges can't both win.
    const [code] = await db
      .update(mcpOauthCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(mcpOauthCodes.codeHash, hashSecret(p.code)),
          isNull(mcpOauthCodes.usedAt),
          gt(mcpOauthCodes.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!code || code.clientId !== client.clientId) {
      throw new OAuthFailure("invalid_grant", "Code is invalid, expired or already used");
    }
    if (p.redirect_uri && p.redirect_uri !== code.redirectUri) {
      throw new OAuthFailure("invalid_grant", "redirect_uri doesn't match the authorization request");
    }
    const challenge = createHash("sha256").update(p.code_verifier).digest("base64url");
    if (!safeEqual(challenge, code.codeChallenge)) {
      throw new OAuthFailure("invalid_grant", "PKCE verification failed");
    }
    const [agent] = await db
      .select()
      .from(mcpAgents)
      .where(and(eq(mcpAgents.id, code.agentId), isNull(mcpAgents.revokedAt)));
    if (!agent) throw new OAuthFailure("invalid_grant", "That agent has been revoked");
    return issueTokens(agent.id, client.clientId, agent.access);
  }

  if (p.grant_type === "refresh_token") {
    if (!p.refresh_token) throw new OAuthFailure("invalid_request", "refresh_token is required");
    const hash = hashSecret(p.refresh_token);
    const [row] = await db
      .select()
      .from(mcpTokens)
      .where(and(eq(mcpTokens.tokenHash, hash), eq(mcpTokens.kind, "refresh")));
    if (!row || row.clientId !== client.clientId) {
      throw new OAuthFailure("invalid_grant", "Unknown refresh token");
    }
    if (row.revokedAt && Date.now() - row.revokedAt.getTime() < REUSE_GRACE_MS) {
      // Rotated moments ago: a client retrying after a dropped response, not
      // a thief. Refuse, but don't cut the connection over a network blip.
      throw new OAuthFailure("invalid_grant", "Refresh token already used");
    }
    if (row.revokedAt) {
      // Rotated a while ago: someone else has this token. Cut the whole grant.
      await db
        .update(mcpTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(mcpTokens.agentId, row.agentId),
            eq(mcpTokens.clientId, client.clientId),
            isNull(mcpTokens.revokedAt),
          ),
        );
      throw new OAuthFailure("invalid_grant", "Refresh token reuse detected; the connection was revoked");
    }
    if (row.expiresAt && row.expiresAt <= new Date()) {
      throw new OAuthFailure("invalid_grant", "Refresh token expired — reconnect");
    }
    const [rotated] = await db
      .update(mcpTokens)
      .set({ revokedAt: new Date(), lastUsedAt: new Date() })
      .where(and(eq(mcpTokens.id, row.id), isNull(mcpTokens.revokedAt)))
      .returning({ id: mcpTokens.id });
    if (!rotated) throw new OAuthFailure("invalid_grant", "Refresh token already used");
    const [agent] = await db
      .select()
      .from(mcpAgents)
      .where(and(eq(mcpAgents.id, row.agentId), isNull(mcpAgents.revokedAt)));
    if (!agent) throw new OAuthFailure("invalid_grant", "That agent has been revoked");
    return issueTokens(agent.id, client.clientId, agent.access);
  }

  throw new OAuthFailure("unsupported_grant_type", `Unsupported grant_type ${p.grant_type ?? "(none)"}`);
}

/** Parses `Authorization: Basic base64(id:secret)` (RFC 6749 §2.3.1, form-encoded parts). */
export function parseBasicAuth(header: string | null): { id: string; secret: string } | null {
  if (!header?.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return {
      id: decodeURIComponent(decoded.slice(0, i)),
      secret: decodeURIComponent(decoded.slice(i + 1)),
    };
  } catch {
    return null;
  }
}
