/**
 * Who is calling the MCP server, what they may do, and the record of what
 * they did.
 *
 * Three kinds of credential reach /api/mcp, all as `Authorization: Bearer …`:
 *  - `rtx_…`  a static agent token, minted in Settings for one agent;
 *  - `rtxa_…` an OAuth access token, minted when the owner approves a
 *             claude.ai connector (src/lib/mcp-oauth.ts);
 *  - anything else is compared (by the route) against the legacy MCP_TOKEN
 *    secret — one shared, full-access identity kept so existing agents
 *    survive the deploy.
 *
 * Whatever authenticated, the request runs inside a `Caller` context
 * (AsyncLocalStorage), which the route reads in three places: to register
 * only the tools this caller may use (so tools/list shows an agent exactly
 * its own surface), to stamp identity onto writes, and to audit every call.
 * The context is per request by construction — the MCP server itself is
 * built per request in stateless mode.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { mcpAgents, mcpAudit, mcpTokens, type McpAccess } from "@/db/schema";

export type Caller = {
  /** The agent's key, or LEGACY_AGENT_KEY for the shared MCP_TOKEN. */
  agentKey: string;
  agentId: number | null;
  access: McpAccess;
  /** Allowlist narrowing `access`; null = everything the access level allows. */
  tools: string[] | null;
  via: "static" | "access" | "legacy";
  /**
   * True when the identity comes from the credential itself. Only then is it
   * stamped onto writes; the legacy token is shared, so whatever its callers
   * say about themselves is all there is to go on.
   */
  bound: boolean;
};

export const LEGACY_AGENT_KEY = "legacy-token";
/** The one vocabulary for agent keys — report_agent_run, add_note authors, identities. */
export const AGENT_KEY_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
/** An agent that can't report looks dead on the Agents page, so every caller may. */
const ALWAYS_ALLOWED = new Set(["report_agent_run"]);

/* ------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------ */

export type SecretPrefix = "rtx" | "rtxa" | "rtxr" | "rtxc" | "rtxs";

/** 256 random bits, URL-safe, with a prefix that says what it is. */
export function newSecret(prefix: SecretPrefix): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** SHA-256 hex. Right for 256-bit random secrets; never use it for passwords. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function secretHint(secret: string): string {
  return secret.slice(-4);
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

/**
 * The shared MCP_TOKEN, as a caller. Full access, because that's what it has
 * always had and existing agents depend on it; unbound, because it's shared.
 * The route checks the token itself (its long-standing `authorized()`).
 */
export const LEGACY_CALLER: Caller = {
  agentKey: LEGACY_AGENT_KEY,
  agentId: null,
  access: "write",
  tools: null,
  via: "legacy",
  bound: false,
};

/** Only our own prefixes are looked up, so a random probe never costs a query. */
export function isAgentToken(bearer: string | undefined): bearer is string {
  return !!bearer && (bearer.startsWith("rtx_") || bearer.startsWith("rtxa_"));
}

/**
 * The agent behind a static or OAuth access token, or null if the token is
 * unknown, revoked, expired, or its agent is revoked. Looked up by hash.
 */
export async function verifyAgentToken(bearer: string | undefined): Promise<Caller | null> {
  if (!isAgentToken(bearer)) return null;
  const db = getDb();
  const [row] = await db
    .select({
      tokenId: mcpTokens.id,
      kind: mcpTokens.kind,
      lastUsedAt: mcpTokens.lastUsedAt,
      agentId: mcpAgents.id,
      key: mcpAgents.key,
      access: mcpAgents.access,
      tools: mcpAgents.tools,
    })
    .from(mcpTokens)
    .innerJoin(mcpAgents, eq(mcpAgents.id, mcpTokens.agentId))
    .where(
      and(
        eq(mcpTokens.tokenHash, hashSecret(bearer)),
        // A refresh token is never a bearer credential.
        inArray(mcpTokens.kind, ["static", "access"]),
        isNull(mcpTokens.revokedAt),
        isNull(mcpAgents.revokedAt),
        or(isNull(mcpTokens.expiresAt), gt(mcpTokens.expiresAt, new Date())),
      ),
    );
  if (!row) return null;
  // Minute resolution is plenty for "last used", and skips a write per call.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, row.tokenId));
  }
  return {
    agentKey: row.key,
    agentId: row.agentId,
    access: row.access,
    tools: row.tools,
    via: row.kind === "access" ? "access" : "static",
    bound: true,
  };
}

/* ------------------------------------------------------------------ *
 * Request context
 * ------------------------------------------------------------------ */

const callerStore = new AsyncLocalStorage<Caller>();

export function runAsCaller<T>(caller: Caller, fn: () => T): T {
  return callerStore.run(caller, fn);
}

export function currentCaller(): Caller | undefined {
  return callerStore.getStore();
}

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

export function canCall(caller: Caller, tool: string, kind: "read" | "write"): boolean {
  if (ALWAYS_ALLOWED.has(tool)) return true;
  if (kind === "write" && caller.access !== "write") return false;
  return caller.tools === null || caller.tools.includes(tool);
}

/**
 * Tool arguments that say who is writing. For a bound caller they're
 * overwritten with the credential's identity, so an agent can't file work
 * under another agent's name. Keyed here, not in each tool, so tools added
 * later (and on other branches) opt in with one line.
 */
const IDENTITY_ARGS: Record<string, string> = {
  report_agent_run: "agent",
  add_note: "author",
  add_contacts: "author",
  // From the follow-ups branch; inert until that tool exists here.
  save_follow_ups: "author",
};

export function stampIdentity(caller: Caller, tool: string, args: unknown): unknown {
  const field = IDENTITY_ARGS[tool];
  if (!caller.bound || !field || !args || typeof args !== "object") return args;
  return { ...(args as Record<string, unknown>), [field]: caller.agentKey };
}

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

export const AUDIT_RETENTION_DAYS = 180;
const MAX_VERBATIM_CHARS = 120;
const MAX_VERBATIM_ITEMS = 10;

/**
 * A redacted outline of tool arguments: ids, flags, dates and short strings
 * verbatim; long text as its length. Enough to answer "what did this agent
 * touch" without the log becoming a second copy of transcripts, summaries
 * and draft bodies.
 */
export function outlineArgs(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length <= MAX_VERBATIM_CHARS ? v : `[${v.length} chars]`;
  if (Array.isArray(v)) {
    if (depth >= 2 || v.length > MAX_VERBATIM_ITEMS) return `[${v.length} items]`;
    return v.map((x) => outlineArgs(x, depth + 1));
  }
  if (typeof v === "object") {
    if (depth >= 2) return "[object]";
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, outlineArgs(x, depth + 1)]),
    );
  }
  return String(v);
}

export async function recordAudit(entry: {
  caller: Caller;
  tool: string;
  kind: "read" | "write";
  ok: boolean;
  error?: string | null;
  args: unknown;
  durationMs: number;
}): Promise<void> {
  const db = getDb();
  const [row] = await db
    .insert(mcpAudit)
    .values({
      agentKey: entry.caller.agentKey,
      agentId: entry.caller.agentId,
      via: entry.caller.via,
      tool: entry.tool,
      kind: entry.kind,
      ok: entry.ok,
      error: entry.error ? entry.error.slice(0, 500) : null,
      args: outlineArgs(entry.args) ?? null,
      durationMs: Math.round(entry.durationMs),
    })
    .returning({ id: mcpAudit.id });
  // Prune on a fraction of writes rather than on a schedule: no job to
  // register, and the table can't outgrow its retention by more than a few
  // hundred rows.
  if (row && row.id % 200 === 0) {
    await db
      .delete(mcpAudit)
      .where(lt(mcpAudit.at, sql`now() - make_interval(days => ${AUDIT_RETENTION_DAYS})`));
  }
}

/**
 * Did a tool's reply report failure? Tools answer `{ ok: false, error }` or
 * `{ error }` for things like an unknown id — a success at the protocol
 * level that the audit log should still show as a miss.
 */
export function replyError(result: {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}): string | null {
  const text = result.content?.[0]?.text;
  if (result.isError) return text?.slice(0, 500) ?? "error";
  if (!text || text.length > 200_000) return null;
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; error?: unknown };
    if (parsed && typeof parsed === "object" && (parsed.ok === false || typeof parsed.error === "string")) {
      return typeof parsed.error === "string" ? parsed.error : "ok: false";
    }
  } catch {
    // Not JSON — nothing to judge.
  }
  return null;
}
