import { formatDistanceToNowStrict } from "date-fns";
import { listAgentViews, type AgentView } from "@/lib/agent-runs";
import type { AgentRunStatus, McpAuditRow } from "@/db/schema";
import { cn } from "@/lib/utils";
import { isDemo } from "@/lib/demo";
import { legacyTokenStatus, listIdentities, recentAudit, type IdentityView } from "@/lib/mcp-agents";
import { ConnectAgents, IdentityPanel } from "@/components/agent-access";

/**
 * The agents working on Rontext from outside it: what each does, where it
 * runs, what it may touch, and what it did. Rontext runs no models itself —
 * runs come from MCP `report_agent_run`, access from the agent's identity
 * (src/lib/mcp-auth.ts), and the activity log from every tool call.
 */
export const metadata = { title: "Agents · Rontext" };
export const dynamic = "force-dynamic";

const STATUS: Record<AgentRunStatus, { label: string; className: string }> = {
  ok: { label: "OK", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400" },
  nothing: { label: "Nothing new", className: "bg-muted text-muted-foreground" },
  partial: { label: "Partial", className: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400" },
};

function ago(d: Date): string {
  return `${formatDistanceToNowStrict(d)} ago`;
}

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", className)}>
      {children}
    </span>
  );
}

function AgentCard({
  a,
  identity,
  readOnly,
}: {
  a: AgentView;
  identity: IdentityView | undefined;
  readOnly: boolean;
}) {
  const last = a.runs[0];
  return (
    <section className="rounded-xl border border-border bg-background">
      <div className="flex items-start gap-3 px-5 pt-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-foreground">{a.def?.name ?? a.key}</h2>
          <p className="pt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {a.def?.description ??
              identity?.note ??
              (a.runs.length
                ? "Reports to Rontext but isn't listed in src/lib/agents.ts yet."
                : "Has access but hasn't reported a run yet.")}
          </p>
        </div>
        {a.overdue ? (
          <Pill className="bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
            {a.lastOkAt ? "Overdue" : "Never run"}
          </Pill>
        ) : last ? (
          <Pill className={STATUS[last.status].className}>{STATUS[last.status].label}</Pill>
        ) : null}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-5 pt-3 text-[12px]">
        {a.def ? (
          <>
            <dt className="text-muted-foreground">Runs on</dt>
            <dd className="text-foreground">{a.def.runsOn}</dd>
            <dt className="text-muted-foreground">Schedule</dt>
            <dd className="text-foreground">{a.def.schedule}</dd>
            <dt className="text-muted-foreground">Writes</dt>
            <dd className="font-mono text-[11.5px] text-foreground">{a.def.writes.join(", ")}</dd>
            <dt className="text-muted-foreground">Defined by</dt>
            <dd className="text-foreground">{a.def.definedBy}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Last success</dt>
        <dd className="text-foreground">{a.lastOkAt ? ago(a.lastOkAt) : "—"}</dd>
      </dl>

      {identity ? (
        <IdentityPanel identity={identity} readOnly={readOnly} />
      ) : (
        <p className="px-5 pt-3 text-[12px] text-muted-foreground">
          No token of its own — it calls in on the shared legacy token, so what it writes isn&apos;t
          attributed to it. Create one named <span className="font-mono">{a.key}</span> above.
        </p>
      )}

      <div className="mt-3 border-t border-border">
        {a.runs.length === 0 ? (
          <p className="px-5 py-3 text-[12.5px] text-muted-foreground">No runs reported yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {a.runs.map((r) => (
              <li key={r.id} className="flex items-baseline gap-3 px-5 py-2 text-[12.5px]">
                <span className="w-24 shrink-0 text-muted-foreground" title={r.finishedAt.toISOString()}>
                  {ago(r.finishedAt)}
                </span>
                <Pill className={STATUS[r.status].className}>{STATUS[r.status].label}</Pill>
                <span className="min-w-0 flex-1 text-foreground">{r.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The shared MCP_TOKEN: still honored, never attributed. */
function LegacyCard({ lastUsedAt }: { lastUsedAt: Date | null }) {
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/60 px-5 py-4 dark:border-amber-900/50 dark:bg-amber-950/30">
      <h2 className="text-[14px] font-semibold text-foreground">Shared legacy token</h2>
      <p className="pt-1 text-[12.5px] leading-relaxed text-muted-foreground">
        MCP_TOKEN still works, with full access, for anything configured before per-agent tokens.
        Whatever uses it can&apos;t be told apart or revoked on its own. Last used{" "}
        {lastUsedAt ? ago(lastUsedAt) : "— no calls logged yet"}. Give each agent its own token, then
        clear MCP_TOKEN in Settings → Connections.
      </p>
    </section>
  );
}

function ActivityLog({ rows }: { rows: McpAuditRow[] }) {
  return (
    <section className="rounded-xl border border-border bg-background">
      <div className="px-5 pt-4">
        <h2 className="text-[14px] font-semibold text-foreground">Activity</h2>
        <p className="pt-0.5 text-[12.5px] text-muted-foreground">
          Every tool call, newest first. Long text is logged as its length, never its content.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-3 text-[12.5px] text-muted-foreground">No calls yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-baseline gap-3 px-5 py-1.5 text-[12px]">
              <span className="w-20 shrink-0 text-muted-foreground" title={r.at.toISOString()}>
                {ago(r.at)}
              </span>
              <span className="w-32 shrink-0 truncate text-foreground">{r.agentKey}</span>
              <span className={cn("w-40 shrink-0 truncate font-mono text-[11.5px]", r.kind === "write" ? "text-foreground" : "text-muted-foreground")}>
                {r.tool}
              </span>
              {r.ok ? null : (
                <Pill className={STATUS.failed.className}>Miss</Pill>
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={r.error ?? undefined}>
                {r.error ?? (r.args ? JSON.stringify(r.args) : "")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function AgentsPage() {
  const [views, identities, audit, legacy] = await Promise.all([
    listAgentViews(),
    listIdentities(),
    recentAudit(),
    legacyTokenStatus(),
  ]);
  const readOnly = isDemo();
  // An agent with credentials but no runs yet still gets a card.
  const byKey = new Map(identities.map((i) => [i.key, i]));
  const seen = new Set(views.map((v) => v.key));
  const agents: AgentView[] = [
    ...views,
    ...identities
      .filter((i) => !seen.has(i.key))
      .map((i) => ({ def: null, key: i.key, runs: [], lastOkAt: null, overdue: false })),
  ];
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b border-border px-5 pb-2.5 pt-3">
        <h1 className="text-[15px] font-semibold text-foreground">Agents</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16 pt-4">
        <p className="max-w-3xl pb-4 text-[12.5px] leading-relaxed text-muted-foreground">
          Claude agents that work on your CRM through its MCP tools. Each has its own identity:
          what it may do, the credentials it holds, and what it reported. Rontext runs no models
          itself.
        </p>
        <div className="flex max-w-3xl flex-col gap-4">
          {!readOnly ? <ConnectAgents /> : null}
          {legacy.set ? <LegacyCard lastUsedAt={legacy.lastUsedAt} /> : null}
          {agents.map((a) => (
            <AgentCard key={a.key} a={a} identity={byKey.get(a.key)} readOnly={readOnly} />
          ))}
          <ActivityLog rows={audit} />
        </div>
      </div>
    </div>
  );
}
