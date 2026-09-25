import { formatDistanceToNowStrict } from "date-fns";
import { listAgentViews, type AgentView } from "@/lib/agent-runs";
import type { AgentRunStatus } from "@/db/schema";
import { cn } from "@/lib/utils";

/**
 * The agents working on Rontext from outside it: what each does, where it
 * runs, and what its recent runs reported. Rontext runs no models itself —
 * this page only shows what agents told it via MCP `report_agent_run`.
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

function AgentCard({ a }: { a: AgentView }) {
  const last = a.runs[0];
  return (
    <section className="rounded-xl border border-border bg-background">
      <div className="flex items-start gap-3 px-5 pt-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-foreground">{a.def?.name ?? a.key}</h2>
          <p className="pt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {a.def?.description ?? "Reports to Rontext but isn't listed in src/lib/agents.ts yet."}
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

export default async function AgentsPage() {
  const agents = await listAgentViews();
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b border-border px-5 pb-2.5 pt-3">
        <h1 className="text-[15px] font-semibold text-foreground">Agents</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16 pt-4">
        <p className="max-w-3xl pb-4 text-[12.5px] leading-relaxed text-muted-foreground">
          Claude agents that work on your CRM through its MCP tools. Rontext runs no models
          itself — each agent reports its runs here when it finishes.
        </p>
        <div className="flex max-w-3xl flex-col gap-4">
          {agents.map((a) => (
            <AgentCard key={a.key} a={a} />
          ))}
        </div>
      </div>
    </div>
  );
}
