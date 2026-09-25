import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appState, DRAFT_CHANNELS, groups, threadSummaries } from "@/db/schema";
import {
  MCP_DRAFT_MODEL,
  MCP_TOOLS,
  type McpToolName,
} from "@/lib/mcp-manifest";
import { getSecretCached } from "@/lib/secrets";
import { listContactFacets } from "@/lib/contact-facets";
import { searchContacts, SEARCH_SORTS } from "@/lib/contact-search";
import { addNote, getContactDetail, listReconnectSuggestions } from "@/lib/actions/contacts";
import {
  completeReminder,
  createReminder,
  listUpcomingReminders,
} from "@/lib/actions/reminders";
import { createDraft } from "@/lib/actions/drafts";
import { ingestMeeting } from "@/lib/meetings";
import { ensureFresh, findPeople } from "@/lib/memory/search";
import { introPaths, type IntroTarget } from "@/lib/intros";

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
 * Drop the fields that carry no information — null, false, 0, and empty
 * arrays — from a result row.
 *
 * At one row this is pointless; at a hundred it is most of the payload, since
 * coverage in this book is sparse (a fifth of people have a location, a sixth
 * have notes). Absence is unambiguous for every field it touches: no `groups`
 * key means no groups, and `starred` present means starred. Documented on the
 * tool so a reader never has to infer that.
 */
function compact<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined || v === false || v === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
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
  list_filter_values: {
    schema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe("Values per list, most people first"),
    }),
    run: async ({ limit }: { limit: number }) => {
      const facets = await listContactFacets(limit);
      return json({
        ...facets,
        note:
          "Counts are exactly what search_contacts returns for that value. " +
          "Matching is substring, so a value not listed here can still match — " +
          '"Whitman" finds the Syracuse sub-school, "Chicago" finds every ' +
          "spelling of the city.",
      });
    },
  },

  search_contacts: {
    schema: z.object({
      query: z
        .string()
        .min(1)
        .optional()
        .describe("Free text across name, company, title, headline, location, hometown, email"),
      group: z
        .array(z.string().min(1))
        .optional()
        .describe('Group names — ALL must match, e.g. ["Yale", "Red"] means both'),
      location: z.string().min(1).optional().describe('City or region, e.g. "Chicago"'),
      school: z.string().min(1).optional().describe("School or degree text"),
      company: z.string().min(1).optional(),
      title: z.string().min(1).optional().describe("Matched against job title and LinkedIn headline"),
      hometown: z.string().min(1).optional().describe("Where they are from, not where they live"),
      notes_contain: z
        .string()
        .min(1)
        .optional()
        .describe("Substring of a note body; matching rows come back with a snippet"),
      starred: z.boolean().optional(),
      has_notes: z.boolean().optional(),
      last_interaction_before: z
        .string()
        .optional()
        .describe("ISO date. Never-contacted people are excluded, not included"),
      last_interaction_after: z.string().optional().describe("ISO date"),
      include_archived: z.boolean().default(false),
      sort: z
        .enum(SEARCH_SORTS)
        .default("best")
        .describe("best = name relevance; stale = coldest first, for reconnecting"),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0).describe("Paging; `total` says how many matched"),
    }),
    run: async (a: {
      query?: string;
      group?: string[];
      location?: string;
      school?: string;
      company?: string;
      title?: string;
      hometown?: string;
      notes_contain?: string;
      starred?: boolean;
      has_notes?: boolean;
      last_interaction_before?: string;
      last_interaction_after?: string;
      include_archived: boolean;
      sort: (typeof SEARCH_SORTS)[number];
      limit: number;
      offset: number;
    }) => {
      const result = await searchContacts({
        query: a.query,
        groups: a.group,
        location: a.location,
        school: a.school,
        company: a.company,
        title: a.title,
        hometown: a.hometown,
        notesContain: a.notes_contain,
        starred: a.starred,
        hasNotes: a.has_notes,
        lastInteractionBefore: a.last_interaction_before,
        lastInteractionAfter: a.last_interaction_after,
        includeArchived: a.include_archived,
        sort: a.sort,
        limit: a.limit,
        offset: a.offset,
      });
      return json({
        total: result.total,
        returned: result.rows.length,
        offset: result.offset,
        // Empty/zero fields are dropped — see compact(). At a hundred sparse
        // rows that is most of the payload.
        contacts: result.rows.map(compact),
      });
    },
  },

  find_people: {
    schema: z.object({
      query: z
        .string()
        .min(2)
        .max(500)
        .describe("What you're looking for, in plain language"),
      group: z
        .array(z.string().min(1))
        .optional()
        .describe('Group names — ALL must match, e.g. ["Yale", "Red"] means both'),
      location: z.string().min(1).optional().describe('City or region, e.g. "Chicago"'),
      school: z.string().min(1).optional(),
      company: z.string().min(1).optional(),
      starred: z.boolean().optional(),
      last_interaction_before: z
        .string()
        .optional()
        .describe("ISO date. Never-contacted people are excluded, not included"),
      last_interaction_after: z.string().optional().describe("ISO date"),
      include_archived: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).default(15),
    }),
    run: async (a: {
      query: string;
      group?: string[];
      location?: string;
      school?: string;
      company?: string;
      starred?: boolean;
      last_interaction_before?: string;
      last_interaction_after?: string;
      include_archived: boolean;
      limit: number;
    }) => {
      // Picks up notes and meetings added since the last refresh; a no-op
      // (one app_state read) when the index is under ten minutes old.
      await ensureFresh();
      const result = await findPeople(
        a.query,
        {
          groups: a.group,
          location: a.location,
          school: a.school,
          company: a.company,
          starred: a.starred,
          lastInteractionBefore: a.last_interaction_before,
          lastInteractionAfter: a.last_interaction_after,
          includeArchived: a.include_archived,
        },
        a.limit,
      );
      return json({
        mode: result.mode,
        ...(result.note ? { note: result.note } : {}),
        returned: result.people.length,
        people: result.people.map(compact),
      });
    },
  },

  intro_paths: {
    schema: z
      .object({
        contact_id: z.number().int().optional().describe("A specific person in the book"),
        company: z.string().min(1).optional().describe("Everyone at this company, e.g. \"McKinsey\""),
        query: z
          .string()
          .min(2)
          .max(500)
          .optional()
          .describe('Plain language, e.g. "someone in climate VC"'),
        limit: z.number().int().min(1).max(25).default(8),
      })
      .refine(
        (a) => [a.contact_id, a.company, a.query].filter((v) => v !== undefined).length === 1,
        { message: "Give exactly one of contact_id, company, or query" },
      ),
    run: async (a: { contact_id?: number; company?: string; query?: string; limit: number }) => {
      const target: IntroTarget =
        a.contact_id !== undefined
          ? { contactId: a.contact_id }
          : a.company
            ? { company: a.company }
            : { query: a.query! };
      if ("query" in target) await ensureFresh();
      const paths = await introPaths(target, a.limit);
      return json({
        returned: paths.length,
        ...(paths.length ? {} : { note: "Nobody in the book matched that target." }),
        paths: paths.map((p) => ({
          ...p,
          target: compact(p.target),
          introducers: p.introducers.map(compact),
        })),
      });
    },
  },

  get_contact: {
    schema: z.object({
      contact_id: z.number().int().describe("Contact id, from search_contacts"),
      sections: z
        .array(
          z.enum([
            "notes",
            "reminders",
            "drafts",
            "education",
            "documents",
            "changes",
            "activity",
            "conversation",
          ]),
        )
        .optional()
        .describe("Omit for everything; name sections to keep the reply small"),
    }),
    run: async ({
      contact_id,
      sections,
    }: {
      contact_id: number;
      sections?: string[];
    }) => {
      // The names, straight from the table — not listGroups(), which also
      // scans every contact_groups row to compute member counts this reply
      // never shows.
      const [detail, allGroups, threads] = await Promise.all([
        getContactDetail(contact_id),
        getDb().select({ id: groups.id, name: groups.name }).from(groups),
        getDb()
          .select({
            source: threadSummaries.source,
            details: threadSummaries.details,
            messagesCovered: threadSummaries.messagesCovered,
            lastMessageAt: threadSummaries.lastMessageAt,
          })
          .from(threadSummaries)
          .where(eq(threadSummaries.contactId, contact_id)),
      ]);
      if (!detail) return json({ error: `No contact with id ${contact_id}` });
      const want = (s: string) => !sections || sections.includes(s);
      const c = detail.contact;
      const byId = new Map(allGroups.map((g) => [g.id, g.name]));

      return json({
        // Projected, not the raw row: latitude, geocode/scrape stamps, and the
        // Mesh migration ids are storage bookkeeping. They cost tokens in every
        // reply and answer no question an agent can ask.
        contact: compact({
          id: c.id,
          fullName: c.fullName,
          company: c.company,
          title: c.title,
          headline: c.headline,
          emails: c.emails,
          phoneNumbers: c.phoneNumbers,
          linkedinUrl: c.linkedinUrl,
          location: c.location,
          hometown: c.hometown,
          birthday: c.birthday,
          starred: c.starred,
          archived: !!c.archivedAt,
          source: c.source,
          interactionSources: c.interactionSources,
          firstInteractionDate: c.firstInteractionDate,
          lastInteractionDate: c.lastInteractionDate,
          linkedinConnectedOn: c.linkedinConnectedOn,
          hasPhoto: detail.hasPhoto,
        }),
        // Names, not the ids the UI passes around — an agent has no id table.
        groups: detail.groupIds.map((id) => byId.get(id)).filter(Boolean),
        // Every nested list is projected the same way: no contactId (the
        // caller just passed it), no updatedAt, and no row id unless a write
        // tool needs it back — complete_reminder takes a reminder id, nothing
        // takes a note or education id. Repeated across thirty notes, those
        // three fields are a third of the payload and answer nothing.
        ...(want("education")
          ? {
              education: detail.education.map((e) =>
                compact({
                  school: e.school,
                  degree: e.degree,
                  startYear: e.startYear,
                  endYear: e.endYear,
                }),
              ),
            }
          : {}),
        // Newest-first already; capped so one chatty contact can't flood a
        // client's context window.
        ...(want("notes")
          ? {
              notes: detail.notes.slice(0, 30).map((n) => ({
                body: n.body,
                source: n.source,
                createdAt: n.createdAt,
              })),
            }
          : {}),
        ...(want("reminders")
          ? {
              reminders: detail.reminders.map((r) =>
                compact({
                  id: r.id,
                  remindAt: r.remindAt,
                  body: r.body,
                  completedAt: r.completedAt,
                }),
              ),
            }
          : {}),
        ...(want("drafts")
          ? {
              drafts: detail.drafts.map((d) =>
                compact({
                  id: d.id,
                  channel: d.channel,
                  subject: d.subject,
                  body: d.body,
                  source: d.source,
                  sentAt: d.sentAt,
                  updatedAt: d.updatedAt,
                }),
              ),
            }
          : {}),
        ...(want("documents") ? { documents: detail.docs } : {}),
        ...(want("changes")
          ? {
              recentChanges: detail.changes.map((ch) =>
                compact({
                  field: ch.field,
                  from: ch.oldValue,
                  to: ch.newValue,
                  source: ch.source,
                  at: ch.createdAt,
                }),
              ),
            }
          : {}),
        // Claude's summary of the owner's recent texts with this person — the
        // only content-derived field; raw messages are never stored.
        ...(want("conversation") && threads.length
          ? {
              conversation: threads.map((t) => ({
                source: t.source,
                ...t.details,
                messagesCovered: t.messagesCovered,
                lastMessageAt: t.lastMessageAt,
              })),
            }
          : {}),
        ...(want("activity")
          ? {
              monthlyActivity: detail.periods.map((pd) => ({
                month: pd.month,
                source: pd.source,
                sent: pd.sentCount,
                received: pd.receivedCount,
              })),
            }
          : {}),
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

  add_meeting: {
    schema: z.object({
      external_id: z.string().min(1).max(200).describe("The source's meeting id, e.g. Wispr Flow's"),
      title: z.string().max(300),
      started_at: z.string().datetime({ offset: true }).describe("ISO 8601 with Z or offset"),
      ended_at: z.string().datetime({ offset: true }).optional(),
      summary: z.string().max(100_000).optional().describe("Markdown"),
      notes: z.string().max(200_000).optional().describe("Markdown"),
      transcript: z.string().max(2_000_000).optional().describe("Plain text"),
      share_link: z.string().url().max(2_000).optional(),
      attendees: z
        .array(z.string().max(200))
        .max(50)
        .optional()
        .describe("Names or emails as the source lists them — shown as a hint if unmatched"),
      attendee_emails: z.array(z.string().max(320)).max(50).optional(),
      contact_ids: z.array(z.number().int()).max(20).optional(),
    }),
    run: async (a: {
      external_id: string;
      title: string;
      started_at: string;
      ended_at?: string;
      summary?: string;
      notes?: string;
      transcript?: string;
      share_link?: string;
      attendees?: string[];
      attendee_emails?: string[];
      contact_ids?: number[];
    }) =>
      json(
        await ingestMeeting({
          externalId: a.external_id,
          title: a.title,
          startedAt: new Date(a.started_at),
          endedAt: a.ended_at ? new Date(a.ended_at) : null,
          summary: a.summary,
          notes: a.notes,
          transcript: a.transcript,
          shareLink: a.share_link,
          attendees: a.attendees,
          attendeeEmails: a.attendee_emails,
          contactIds: a.contact_ids,
        }),
      ),
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
