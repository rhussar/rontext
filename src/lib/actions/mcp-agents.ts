"use server";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { mcpAgents, mcpTokens, type McpAccess } from "@/db/schema";
import { AGENT_KEY_RE, hashSecret, newSecret, secretHint } from "@/lib/mcp-auth";
import { MCP_TOOLS } from "@/lib/mcp-manifest";

export type TokenResult = { ok: true; token: string; key: string } | { ok: false; error: string };
export type ActionResult = { ok: true } | { ok: false; error: string };

const TOOL_NAMES = new Set<string>(MCP_TOOLS.map((t) => t.name));

/** Null = no allowlist (every tool the access level allows). */
function cleanTools(tools: string[] | null): string[] | null | { error: string } {
  if (tools === null) return null;
  const unknown = tools.filter((t) => !TOOL_NAMES.has(t));
  if (unknown.length) return { error: `Unknown tool: ${unknown.join(", ")}` };
  if (!tools.length) return { error: "Pick at least one tool, or allow all of them" };
  return [...new Set(tools)].sort();
}

async function mint(agentId: number): Promise<string> {
  const token = newSecret("rtx");
  await getDb().insert(mcpTokens).values({
    agentId,
    kind: "static",
    tokenHash: hashSecret(token),
    hint: secretHint(token),
  });
  return token;
}

/** A new agent identity and its first token — the token is returned once and never stored. */
export async function createAgent(input: {
  key: string;
  access: McpAccess;
  tools: string[] | null;
  note?: string;
}): Promise<TokenResult> {
  const key = input.key.trim().toLowerCase();
  if (!AGENT_KEY_RE.test(key)) {
    return { ok: false, error: "Name: 2-49 lowercase letters, digits and dashes, starting with a letter or digit" };
  }
  if (input.access !== "read" && input.access !== "write") return { ok: false, error: "Pick an access level" };
  const tools = cleanTools(input.tools);
  if (tools && "error" in tools) return { ok: false, error: tools.error };

  const db = getDb();
  const [clash] = await db.select({ id: mcpAgents.id }).from(mcpAgents).where(eq(mcpAgents.key, key));
  if (clash) return { ok: false, error: `An agent named "${key}" already exists` };
  const [agent] = await db
    .insert(mcpAgents)
    .values({ key, access: input.access, tools, note: input.note?.trim().slice(0, 200) || null })
    .returning({ id: mcpAgents.id });
  const token = await mint(agent.id);
  revalidatePath("/agents");
  return { ok: true, token, key };
}

/** Another token for an existing live agent — e.g. to rotate: mint, swap, revoke the old one. */
export async function createAgentToken(agentId: number): Promise<TokenResult> {
  const [agent] = await getDb()
    .select({ key: mcpAgents.key })
    .from(mcpAgents)
    .where(and(eq(mcpAgents.id, agentId), isNull(mcpAgents.revokedAt)));
  if (!agent) return { ok: false, error: "That agent is gone or revoked" };
  const token = await mint(agentId);
  revalidatePath("/agents");
  return { ok: true, token, key: agent.key };
}

export async function revokeAgentToken(tokenId: number): Promise<ActionResult> {
  await getDb()
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.kind, "static"), isNull(mcpTokens.revokedAt)));
  revalidatePath("/agents");
  return { ok: true };
}

/** Disconnect one OAuth client (e.g. claude.ai) from an agent: its access and refresh tokens die now. */
export async function revokeAgentConnection(agentId: number, clientId: string): Promise<ActionResult> {
  await getDb()
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpTokens.agentId, agentId),
        eq(mcpTokens.clientId, clientId),
        inArray(mcpTokens.kind, ["access", "refresh"]),
        isNull(mcpTokens.revokedAt),
      ),
    );
  revalidatePath("/agents");
  return { ok: true };
}

/**
 * Revoke the agent itself: every credential stops working on the next call.
 * The row stays (revoked), so its key can't be quietly reissued to something
 * else and its audit history keeps a name to point at.
 */
export async function revokeAgent(agentId: number): Promise<ActionResult> {
  const db = getDb();
  await db
    .update(mcpAgents)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpAgents.id, agentId), isNull(mcpAgents.revokedAt)));
  await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.agentId, agentId), isNull(mcpTokens.revokedAt)));
  revalidatePath("/agents");
  return { ok: true };
}

/** Change what an agent may do. Takes effect on its next request — tokens carry no scopes of their own. */
export async function updateAgentAccess(
  agentId: number,
  access: McpAccess,
  tools: string[] | null,
): Promise<ActionResult> {
  if (access !== "read" && access !== "write") return { ok: false, error: "Pick an access level" };
  const clean = cleanTools(tools);
  if (clean && "error" in clean) return { ok: false, error: clean.error };
  await getDb()
    .update(mcpAgents)
    .set({ access, tools: clean })
    .where(and(eq(mcpAgents.id, agentId), isNull(mcpAgents.revokedAt)));
  revalidatePath("/agents");
  return { ok: true };
}
