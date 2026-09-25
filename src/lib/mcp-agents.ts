/**
 * Read side of agent identities for the Agents page: each agent's access,
 * its credentials (static tokens and OAuth connections), and the audit log.
 * Writes live in src/lib/actions/mcp-agents.ts.
 */
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  mcpAgents,
  mcpAudit,
  mcpOauthClients,
  mcpTokens,
  type McpAccess,
  type McpAuditRow,
} from "@/db/schema";
import { getSecret } from "@/lib/secrets";
import { LEGACY_AGENT_KEY } from "@/lib/mcp-auth";

export type StaticTokenView = {
  id: number;
  hint: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

/** One OAuth grant: an agent connected through one client (e.g. claude.ai). */
export type ConnectionView = {
  clientId: string;
  clientName: string;
  connectedAt: Date;
  lastUsedAt: Date | null;
};

export type IdentityView = {
  id: number;
  key: string;
  access: McpAccess;
  tools: string[] | null;
  note: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  tokens: StaticTokenView[];
  connections: ConnectionView[];
};

export async function listIdentities(): Promise<IdentityView[]> {
  const db = getDb();
  const agents = await db.select().from(mcpAgents).orderBy(mcpAgents.key);
  if (!agents.length) return [];
  const ids = agents.map((a) => a.id);

  const live = and(
    isNull(mcpTokens.revokedAt),
    or(isNull(mcpTokens.expiresAt), gt(mcpTokens.expiresAt, new Date())),
  );
  const [statics, grants] = await Promise.all([
    db
      .select()
      .from(mcpTokens)
      .where(and(inArray(mcpTokens.agentId, ids), eq(mcpTokens.kind, "static"), live))
      .orderBy(desc(mcpTokens.createdAt)),
    // A connection is live while its refresh token is: access tokens come and
    // go hourly, the refresh token is what keeps the connector attached.
    db
      .select({
        agentId: mcpTokens.agentId,
        clientId: mcpTokens.clientId,
        clientName: mcpOauthClients.name,
        connectedAt: sql<Date>`min(${mcpTokens.createdAt})`,
        lastUsedAt: sql<Date | null>`max(${mcpTokens.lastUsedAt})`,
      })
      .from(mcpTokens)
      .innerJoin(mcpOauthClients, eq(mcpOauthClients.clientId, mcpTokens.clientId))
      .where(and(inArray(mcpTokens.agentId, ids), inArray(mcpTokens.kind, ["access", "refresh"])))
      .groupBy(mcpTokens.agentId, mcpTokens.clientId, mcpOauthClients.name)
      .having(
        sql`bool_or(${mcpTokens.kind} = 'refresh' and ${mcpTokens.revokedAt} is null and (${mcpTokens.expiresAt} is null or ${mcpTokens.expiresAt} > now()))`,
      ),
  ]);

  const date = (v: Date | string | null) => (v === null ? null : new Date(v));
  return agents.map((a) => ({
    id: a.id,
    key: a.key,
    access: a.access,
    tools: a.tools,
    note: a.note,
    createdAt: a.createdAt,
    revokedAt: a.revokedAt,
    tokens: statics
      .filter((t) => t.agentId === a.id)
      .map((t) => ({ id: t.id, hint: t.hint, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })),
    connections: grants
      .filter((g) => g.agentId === a.id && g.clientId)
      .map((g) => ({
        clientId: g.clientId!,
        clientName: g.clientName,
        connectedAt: date(g.connectedAt)!,
        lastUsedAt: date(g.lastUsedAt),
      })),
  }));
}

export async function recentAudit(limit = 60): Promise<McpAuditRow[]> {
  return getDb().select().from(mcpAudit).orderBy(desc(mcpAudit.at)).limit(limit);
}

/**
 * The shared MCP_TOKEN, if set: when it was last used. It still works (so
 * nothing breaks on deploy), but everything done with it is unattributed —
 * the page nudges toward moving each agent onto its own token.
 */
export async function legacyTokenStatus(): Promise<{ set: boolean; lastUsedAt: Date | null }> {
  const set = !!(await getSecret("MCP_TOKEN"));
  if (!set) return { set, lastUsedAt: null };
  const [row] = await getDb()
    .select({ at: mcpAudit.at })
    .from(mcpAudit)
    .where(eq(mcpAudit.agentKey, LEGACY_AGENT_KEY))
    .orderBy(desc(mcpAudit.at))
    .limit(1);
  return { set, lastUsedAt: row?.at ?? null };
}
