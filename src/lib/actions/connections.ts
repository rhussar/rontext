"use server";

import { count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactChanges, contacts, scrapeRuns } from "@/db/schema";
import type { ConnectionStatus } from "@/lib/connections";

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

  const [linkedinRun, profiles, linkedinChanges, runs, totals, pending] =
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
  ];
}
