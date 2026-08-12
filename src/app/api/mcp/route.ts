import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { and, desc, ilike, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appState, contacts, DRAFT_CHANNELS } from "@/db/schema";
import {
  MCP_DRAFT_MODEL,
  MCP_TOOLS,
  type McpToolName,
} from "@/lib/mcp-manifest";
import { getSecretCached } from "@/lib/secrets";
import { addNote, getContactDetail, listReconnectSuggestions } from "@/lib/actions/contacts";
import {
  completeReminder,
  createReminder,
  listUpcomingReminders,
} from "@/lib/actions/reminders";
import { createDraft } from "@/lib/actions/drafts";

/**
 * Rontext's MCP server — the machine-callable face of the CRM.
 *
 * One endpoint serves every MCP client (Claude Code, claude.ai via mcp-remote,
 * any other agent runtime), reached at POST /api/mcp with a bearer token.
 *
 * Tool names, titles, and descriptions live in src/lib/mcp-manifest.ts so the
 * Settings → Accounts card and this route can never disagree; the
 * Record<McpToolName, …> below makes a manifest/handler mismatch a compile
 * error in either direction.
 *
 * The tool surface deliberately mirrors what the app's own UI can do, minus
 * anything irreversible or outward-facing:
 *  - No send tool, ever. Drafts land UNSENT behind the same review gate as the
 *    sparkle button — that gate is the prompt-injection control for the whole
 *    app, and an agent-reachable send would defeat it.
 *  - No delete, no merge (merges hard-delete the loser), no settings mutation.
 *
 * Auth is MCP_TOKEN, deliberately a separate credential from APP_PASSCODE: the
 * passcode unlocks the whole UI and mints session cookies; this token grants
 * exactly these tools and can be rotated without logging anyone out. The
 * passcode proxy exempts /api/mcp (src/proxy.ts) because cookie auth is
 * meaningless to an MCP client — the check below is the whole gate, and an
 * unset MCP_TOKEN fails closed.
 */

/**
 * The token can be set in Settings → Setup (DB) or in env; getSecretCached
 * resolves both with a 60s per-instance cache, so an unauthenticated probe
 * doesn't cost a Neon round trip — and a freshly generated or cleared token
 * takes up to 60s to be honored on a warm instance.
 */
async function authorized(req: Request): Promise<boolean> {
  const token = await getSecretCached("MCP_TOKEN");
  if (!token) return false; // unset = feature off, fail closed
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Every tool returns one JSON text block — uniform and easy for clients to parse. */
function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] };
}

/**
 * Schema + handler per manifest tool. The mapped-record type is the drift
 * guard: remove a tool from the manifest and its entry here errors as an
 * excess key; add one there and this object errors as incomplete.
 */
const impl: Record<
  McpToolName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { schema: z.ZodType<any>; run: (args: any) => Promise<{ content: { type: "text"; text: string }[] }> }
> = {
  search_contacts: {
    schema: z.object({
      query: z.string().min(1).describe("Substring matched against name, company, and title"),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    run: async ({ query, limit }: { query: string; limit: number }) => {
      const q = `%${query}%`;
      const rows = await getDb()
        .select({
          id: contacts.id,
          fullName: contacts.fullName,
          company: contacts.company,
          title: contacts.title,
          location: contacts.location,
          lastInteractionDate: contacts.lastInteractionDate,
          starred: contacts.starred,
        })
        .from(contacts)
        .where(
          and(
            isNull(contacts.archivedAt),
            or(
              ilike(contacts.fullName, q),
              ilike(contacts.company, q),
              ilike(contacts.title, q),
            ),
          ),
        )
        .orderBy(desc(sql`${contacts.lastInteractionDate} is not null`), contacts.fullName)
        .limit(limit);
      return json({ count: rows.length, contacts: rows });
    },
  },

  get_contact: {
    schema: z.object({
      contact_id: z.number().int().describe("Contact id, from search_contacts"),
    }),
    run: async ({ contact_id }: { contact_id: number }) => {
      const detail = await getContactDetail(contact_id);
      if (!detail) return json({ error: `No contact with id ${contact_id}` });
      return json({
        contact: detail.contact,
        // Newest-first already; capped so one chatty contact can't flood a
        // client's context window.
        notes: detail.notes.slice(0, 30),
        reminders: detail.reminders,
        drafts: detail.drafts,
        recentChanges: detail.changes,
        monthlyActivity: detail.periods,
      });
    },
  },

  list_reconnect_suggestions: {
    schema: z.object({
      limit: z.number().int().min(1).max(25).default(10),
    }),
    run: async ({ limit }: { limit: number }) =>
      json(await listReconnectSuggestions(limit)),
  },

  list_upcoming_reminders: {
    schema: z.object({}),
    run: async () => json(await listUpcomingReminders()),
  },

  add_note: {
    schema: z.object({
      contact_id: z.number().int(),
      body: z.string().min(1).max(10_000),
    }),
    run: async ({ contact_id, body }: { contact_id: number; body: string }) =>
      json(await addNote(contact_id, body)),
  },

  create_reminder: {
    schema: z.object({
      contact_id: z.number().int(),
      remind_at: z.string().describe("ISO 8601 datetime, e.g. 2026-08-20T10:00:00"),
      body: z.string().max(2_000).optional(),
    }),
    run: async ({
      contact_id,
      remind_at,
      body,
    }: {
      contact_id: number;
      remind_at: string;
      body?: string;
    }) => json(await createReminder(contact_id, remind_at, body)),
  },

  complete_reminder: {
    schema: z.object({
      reminder_id: z.number().int(),
    }),
    run: async ({ reminder_id }: { reminder_id: number }) =>
      json(await completeReminder(reminder_id)),
  },

  create_draft: {
    schema: z.object({
      contact_id: z.number().int(),
      channel: z.enum(DRAFT_CHANNELS),
      body: z.string().min(1).max(10_000),
      subject: z.string().max(300).optional().describe("Email only; dropped for sms/linkedin"),
    }),
    run: async ({
      contact_id,
      channel,
      body,
      subject,
    }: {
      contact_id: number;
      channel: (typeof DRAFT_CHANNELS)[number];
      body: string;
      subject?: string;
    }) =>
      json(
        // Tagged as AI-origin on purpose: the app's draft generator learns the
        // owner's voice from source='manual' drafts only, and agent-authored
        // text must not masquerade as the owner's own writing.
        await createDraft(contact_id, channel, body, subject, {
          generatedBody: body,
          generatedSubject: subject ?? null,
          model: MCP_DRAFT_MODEL,
          promptVersion: 0,
        }),
      ),
  },
};

const handler = createMcpHandler((server) => {
  for (const tool of MCP_TOOLS) {
    const { schema, run } = impl[tool.name];
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: schema },
      run,
    );
  }
});

/**
 * Usage stamp behind the Settings → Accounts MCP card. Counts only tools/call
 * requests — the initialize/tools-list chatter every client sends on connect
 * would otherwise inflate the number without any work having happened.
 *
 * Awaited (not fire-and-forget) because serverless kills the process once the
 * response is written; one upsert over neon-http is cheap next to the tool
 * call it accompanies.
 */
async function stampUsage(req: Request): Promise<void> {
  try {
    const body = await req.clone().json();
    const calls = (Array.isArray(body) ? body : [body]).filter(
      (m) => m?.method === "tools/call",
    ).length;
    if (calls === 0) return;
    await getDb()
      .insert(appState)
      .values([
        { key: "mcpLastUsedAt", value: new Date().toISOString() },
        { key: "mcpCallCount", value: String(calls) },
      ])
      .onConflictDoUpdate({
        target: appState.key,
        set: {
          value: sql`case ${appState.key}
            when 'mcpCallCount' then ((coalesce(nullif(${appState.value}, ''), '0'))::int + excluded.value::int)::text
            else excluded.value end`,
          updatedAt: new Date(),
        },
      });
  } catch {
    // A malformed body will fail in the handler with a proper JSON-RPC error;
    // the stamp must never be the thing that breaks a request.
  }
}

async function guarded(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }
  const [response] = await Promise.all([handler(req), stampUsage(req)]);
  return response;
}

export { guarded as GET, guarded as POST };

/** Tool handlers are DB round trips over neon-http; give them headroom. */
export const maxDuration = 60;
