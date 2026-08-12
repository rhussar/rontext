"use server";

import { count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactChanges, contacts, scrapeRuns } from "@/db/schema";
import type { ConnectionStatus } from "@/lib/connections";
import { MCP_DRAFT_MODEL, MCP_TOOLS } from "@/lib/mcp-manifest";
import { getSecret } from "@/lib/secrets";

/**
 * Status for all three Settings → Accounts cards.
 *
 * Every connector derives "connected" the same way — it has produced a run —
 * because none of them stores a credential to check.
 *
 * The app layout calls this on every page load, so Gmail and Messages share
 * three grouped queries rather than running four apiece. Six round trips in
 * total, all in flight at once.
 */
export async function getConnectionStatuses(): Promise<ConnectionStatus[]> {
  const db = getDb();

  const [linkedinRun, profiles, linkedinChanges, runs, totals, pending, social, mcp, mcpToken] =
    await Promise.all([
      db
        .select({ createdAt: scrapeRuns.createdAt })
        .from(scrapeRuns)
        .orderBy(desc(scrapeRuns.createdAt))
        .limit(1),
      db.select({ n: count() }).from(contacts).where(isNotNull(contacts.linkedinUrl)),
      db
        .select({
          changes: sql<number>`count(*)::int`,
          connections: sql<number>`count(*) filter (where ${contactChanges.field} = 'connected')::int`,
        })
        .from(contactChanges)
        .where(eq(contactChanges.source, "linkedin")),
      db.execute<{ connector: string; created_at: Date }>(sql`
        select distinct on (connector) connector, created_at
        from sync_runs
        order by connector, created_at desc
      `),
      db.execute<{ source: string; people: number; messages: number }>(sql`
        select source,
               count(*)::int as people,
               coalesce(sum(message_count), 0)::int as messages
        from interactions
        group by source
      `),
      db.execute<{ source: string; n: number }>(sql`
        select source, count(*)::int as n
        from contact_candidates
        where status = 'pending'
        group by source
      `),
      // One row: the aggregated "Social analytics" card. Three scalar
      // subqueries beat three more round trips in this per-page-load path.
      db.execute<{
        last_run: Date | null;
        platforms: number;
        snapshots: number;
        tracked: number;
      }>(sql`
        select
          (select max(created_at) from social_sync_runs) as last_run,
          (select count(distinct platform)::int from social_sync_runs) as platforms,
          (select count(*)::int from social_account_metrics) as snapshots,
          (select count(distinct post_url)::int from social_post_metrics) as tracked
      `),
      // Usage stamps written by /api/mcp on every tools/call, plus the count
      // of drafts agents have authored (they carry the mcp model tag).
      db.execute<{ last_used: string | null; calls: number; drafts: number }>(sql`
        select
          (select value from app_state where key = 'mcpLastUsedAt') as last_used,
          (select coalesce(nullif(value, ''), '0')::int from app_state where key = 'mcpCallCount') as calls,
          (select count(*)::int from drafts where model = ${MCP_DRAFT_MODEL}) as drafts
      `),
      // Uncached on purpose — a token saved in Setup should flip this card's
      // empty state on the next paint, not a minute later.
      getSecret("MCP_TOKEN"),
    ]);

  const lastRunBy = new Map(runs.rows.map((r) => [r.connector, r.created_at]));
  const totalsBy = new Map(totals.rows.map((r) => [r.source, r]));
  const pendingBy = new Map(pending.rows.map((r) => [r.source, r.n]));

  /**
   * `connector` names the integration ("gmail"); `source` is the interaction
   * vocabulary it writes ("email"), which matches the values already in
   * contacts.interactionSources.
   */
  const connector = (
    key: "gmail" | "messages",
    source: "email" | "messages",
  ): ConnectionStatus => {
    const t = totalsBy.get(source);
    const lastRun = lastRunBy.get(key);
    return {
      key,
      lastSyncAt: lastRun ? new Date(lastRun).toISOString() : null,
      stats: [
        { label: "People", value: t?.people ?? 0 },
        { label: "Messages", value: t?.messages ?? 0 },
        { label: "To review", value: pendingBy.get(key) ?? 0 },
      ],
    };
  };

  return [
    {
      key: "linkedin",
      lastSyncAt: linkedinRun[0]?.createdAt.toISOString() ?? null,
      stats: [
        { label: "Profiles", value: profiles[0]?.n ?? 0 },
        { label: "Updates", value: linkedinChanges[0]?.changes ?? 0 },
        { label: "Connections", value: linkedinChanges[0]?.connections ?? 0 },
      ],
    },
    connector("gmail", "email"),
    connector("messages", "messages"),
    {
      key: "social",
      lastSyncAt: social.rows[0]?.last_run
        ? new Date(social.rows[0].last_run).toISOString()
        : null,
      stats: [
        { label: "Platforms", value: social.rows[0]?.platforms ?? 0 },
        { label: "Snapshots", value: social.rows[0]?.snapshots ?? 0 },
        { label: "Posts tracked", value: social.rows[0]?.tracked ?? 0 },
      ],
    },
    {
      key: "mcp",
      // "Connected" for an inbound integration means an agent has actually
      // called — enabled-but-unused stays in the empty state below.
      lastSyncAt: mcp.rows[0]?.last_used ?? null,
      stats: [
        { label: "Tools", value: MCP_TOOLS.length },
        { label: "Agent calls", value: mcp.rows[0]?.calls ?? 0 },
        { label: "Drafts", value: mcp.rows[0]?.drafts ?? 0 },
      ],
      // Presence check only — the value never leaves the server, same rule as
      // getSetupStatus(). An unset token means /api/mcp fails closed with 401.
      emptyLine: mcpToken
        ? "Enabled — no agent calls yet"
        : "Disabled — add MCP_TOKEN in Setup",
    },
  ];
}
