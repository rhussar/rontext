/**
 * Who may call the MCP server, and what they did — the identity layer for a
 * network hub with many agents on it.
 *
 * Re-exported from schema.ts (drizzle-kit and `@/db` read it from there), but
 * kept in its own file: nothing here references a contact, and these tables
 * change for different reasons than the CRM's.
 *
 * The model:
 *  - An **agent** (`mcp_agents`) is a named identity with an access level and
 *    an optional tool allowlist. Its key is the same kebab-case key it reports
 *    runs under (`report_agent_run`), so the Agents page, the audit log and the
 *    notes it writes all say the same name.
 *  - A **token** (`mcp_tokens`) is a credential for one agent: a static bearer
 *    token pasted into a Claude Code config or a scheduled task, or an OAuth
 *    access/refresh pair minted when a claude.ai connector is approved.
 *    Revoking the agent revokes every token it has.
 *  - Only a SHA-256 of each token is stored. Tokens are 256 random bits, so a
 *    fast hash is the right tool (no password stretching needed), and a
 *    database leak yields nothing that authenticates.
 *
 * The legacy MCP_TOKEN secret still works as one shared, full-access identity
 * ("legacy-token") so existing agents don't break on deploy — Settings flags it
 * until it's cleared.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** "read" = every read tool; "write" = read + write tools. */
export const MCP_ACCESS_LEVELS = ["read", "write"] as const;

export const mcpAgents = pgTable("mcp_agents", {
  id: serial("id").primaryKey(),
  /** Stable kebab-case key, e.g. "wispr-meetings". Unique across live and revoked agents. */
  key: text("key").notNull().unique(),
  access: text("access", { enum: MCP_ACCESS_LEVELS }).notNull().default("read"),
  /**
   * Optional allowlist of tool names, narrowing `access` further. Null = every
   * tool the access level allows. `report_agent_run` is always allowed — an
   * agent that can't report looks dead.
   */
  tools: text("tools").array(),
  /** One line from the owner: what this agent is for. */
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const MCP_TOKEN_KINDS = ["static", "access", "refresh"] as const;

export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .notNull()
      .references(() => mcpAgents.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: MCP_TOKEN_KINDS }).notNull(),
    /** sha256 hex of the token. The token itself is shown once and never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    /** The last four characters, so the owner can tell two tokens apart. */
    hint: text("hint").notNull(),
    /** The OAuth client that holds it (access/refresh only). */
    clientId: text("client_id"),
    /** Null for static tokens, which live until revoked. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("mcp_tokens_agent_idx").on(t.agentId)],
);

/**
 * OAuth clients, created by dynamic client registration (RFC 7591) — how
 * claude.ai introduces itself before sending the owner to the consent page.
 * Registration is open by design (that's what DCR is); it grants nothing by
 * itself. Access only comes from the owner approving on /oauth/authorize,
 * behind the passcode.
 */
export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  clientId: text("client_id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  /** sha256 hex; null for public clients (token_endpoint_auth_method "none"), which rely on PKCE. */
  secretHash: text("secret_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One-time authorization codes: ten minutes, single use, bound to a PKCE challenge. */
export const mcpOauthCodes = pgTable("mcp_oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull(),
  agentId: integer("agent_id")
    .notNull()
    .references(() => mcpAgents.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every MCP tool call: who, what, whether it worked. Arguments are kept only
 * as a redacted outline (short values verbatim, long text as its length), so
 * the log answers "what did this agent touch" without becoming a second copy
 * of transcripts and summaries. Pruned after AUDIT_RETENTION_DAYS.
 */
export const mcpAudit = pgTable(
  "mcp_audit",
  {
    id: serial("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** Kept as text so the history survives the agent being deleted. */
    agentKey: text("agent_key").notNull(),
    agentId: integer("agent_id").references(() => mcpAgents.id, { onDelete: "set null" }),
    /** static / access / legacy — how the caller authenticated. */
    via: text("via").notNull(),
    tool: text("tool").notNull(),
    kind: text("kind", { enum: ["read", "write"] }).notNull(),
    ok: boolean("ok").notNull(),
    /** The tool's own error line when it answered with one. */
    error: text("error"),
    args: jsonb("args"),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [
    index("mcp_audit_at_idx").on(t.at.desc()),
    index("mcp_audit_agent_at_idx").on(t.agentKey, t.at.desc()),
  ],
);

export type McpAgent = typeof mcpAgents.$inferSelect;
export type McpAccess = (typeof MCP_ACCESS_LEVELS)[number];
export type McpToken = typeof mcpTokens.$inferSelect;
export type McpTokenKind = (typeof MCP_TOKEN_KINDS)[number];
export type McpOauthClient = typeof mcpOauthClients.$inferSelect;
export type McpAuditRow = typeof mcpAudit.$inferSelect;
