/**
 * Read and write `agent_runs`. Plain module: the MCP route writes through it,
 * the Agents page reads through it.
 */

import { desc, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentRuns, type AgentRun, type AgentRunStatus } from "@/db/schema";
import { AGENT_BY_KEY, AGENTS, type AgentDef } from "@/lib/agents";

export async function recordAgentRun(input: {
  agent: string;
  status: AgentRunStatus;
  summary: string;
  details?: unknown;
  model?: string;
  startedAt?: Date;
}): Promise<{ ok: true; id: number; known: boolean }> {
  const [row] = await getDb()
    .insert(agentRuns)
    .values({
      agent: input.agent,
      status: input.status,
      summary: input.summary,
      details: input.details ?? null,
      model: input.model ?? null,
      startedAt: input.startedAt ?? null,
    })
    .returning({ id: agentRuns.id });
  return { ok: true, id: row.id, known: AGENT_BY_KEY.has(input.agent) };
}

export type AgentView = {
  def: AgentDef | null;
  key: string;
  runs: AgentRun[];
  lastOkAt: Date | null;
  /** Known agent whose last good run is older than it should be. */
  overdue: boolean;
};

const RUNS_PER_AGENT = 12;

/** Every registered agent (even with no runs yet) plus any unlisted reporter. */
export async function listAgentViews(): Promise<AgentView[]> {
  const res = await getDb().execute<{
    id: number;
    agent: string;
    status: AgentRunStatus;
    summary: string;
    details: unknown;
    model: string | null;
    started_at: string | null;
    finished_at: string;
  }>(sql`
    select * from (
      select r.*, row_number() over (partition by agent order by finished_at desc) as rn
      from agent_runs r
    ) x where rn <= ${RUNS_PER_AGENT}
    order by finished_at desc
  `);
  const lastOk = await getDb()
    .select({ agent: agentRuns.agent, at: sql<string>`max(${agentRuns.finishedAt})` })
    .from(agentRuns)
    .where(sql`${agentRuns.status} in ('ok', 'nothing')`)
    .groupBy(agentRuns.agent)
    .orderBy(desc(agentRuns.agent));

  const runsBy = new Map<string, AgentRun[]>();
  for (const r of res.rows) {
    const list = runsBy.get(r.agent) ?? [];
    list.push({
      id: r.id,
      agent: r.agent,
      status: r.status,
      summary: r.summary,
      details: r.details,
      model: r.model,
      startedAt: r.started_at ? new Date(r.started_at) : null,
      finishedAt: new Date(r.finished_at),
    });
    runsBy.set(r.agent, list);
  }
  const okBy = new Map(lastOk.map((r) => [r.agent, new Date(r.at)]));

  const keys = [...AGENTS.map((a) => a.key), ...[...runsBy.keys()].filter((k) => !AGENT_BY_KEY.has(k))];
  return keys.map((key) => {
    const def = AGENT_BY_KEY.get(key) ?? null;
    const lastOkAt = okBy.get(key) ?? null;
    return {
      def,
      key,
      runs: runsBy.get(key) ?? [],
      lastOkAt,
      overdue:
        !!def && (!lastOkAt || Date.now() - lastOkAt.getTime() > def.expectEveryHours * 3_600_000),
    };
  });
}
