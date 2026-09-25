import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { mcpAgents } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AUTHORIZE_PARAMS, suggestAgentKey, validateAuthorizeRequest } from "@/lib/mcp-oauth";
import { decideAuthorization } from "@/lib/actions/mcp-oauth";

export const metadata: Metadata = { title: "Connect an agent · Rontext" };
export const dynamic = "force-dynamic";

/**
 * The OAuth consent screen. Reached from a connector like claude.ai, behind
 * the passcode (the proxy sends you through /login and back). Approving gives
 * the connector its own agent identity — named here, scoped here, revocable
 * and audited in Settings like any other agent.
 */
export default async function AuthorizePage({ searchParams }: PageProps<"/oauth/authorize">) {
  const raw = await searchParams;
  const params: Record<string, string | undefined> = {};
  for (const k of [...AUTHORIZE_PARAMS, "problem"]) {
    const v = raw[k];
    if (typeof v === "string") params[k] = v;
  }

  const v = await validateAuthorizeRequest(params);
  if (!v.ok && "redirect" in v) redirect(v.redirect);

  if (!v.ok) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-foreground">Can&apos;t connect</h1>
        <p className="pt-2 text-sm text-muted-foreground">{v.show}</p>
      </Shell>
    );
  }

  const req = v.req;
  const redirectHost = new URL(req.redirectUri).host;
  const existing = await getDb()
    .select({ key: mcpAgents.key })
    .from(mcpAgents)
    .where(isNull(mcpAgents.revokedAt));

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-foreground">Connect {req.clientName} to Rontext?</h1>
      <p className="pt-2 text-sm leading-relaxed text-muted-foreground">
        It will reach your contacts through Rontext&apos;s agent tools as its own agent, and send you
        back to <span className="font-medium text-foreground">{redirectHost}</span>. Nothing is ever
        sent to anyone on your behalf — drafts stay unsent for you to review.
      </p>

      <form action={decideAuthorization} className="flex flex-col gap-4 pt-5">
        {AUTHORIZE_PARAMS.map((k) =>
          params[k] ? <input key={k} type="hidden" name={k} value={params[k]} /> : null,
        )}

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Agent name</span>
          <Input
            name="agent_key"
            defaultValue={suggestAgentKey(req.clientName)}
            pattern="[a-z0-9][a-z0-9\-]{1,48}"
            required
            list="existing-agents"
            className="h-10 bg-background font-mono text-[13px]"
          />
          <datalist id="existing-agents">
            {existing.map((a) => (
              <option key={a.key} value={a.key} />
            ))}
          </datalist>
          <span className="text-xs text-muted-foreground">
            Lowercase, digits and dashes. Its notes and runs are filed under this name. Reusing an
            existing agent&apos;s name keeps that agent&apos;s access.
          </span>
        </label>

        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="pb-1.5 font-medium text-foreground">Access</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="access" value="read" defaultChecked={req.requestedAccess === "read"} className="mt-1" />
            <span>
              <span className="text-foreground">Read only</span>
              <span className="block text-xs text-muted-foreground">Search people, read profiles, notes, meetings and context</span>
            </span>
          </label>
          {req.requestedAccess === "write" ? (
            <label className="flex items-start gap-2">
              <input type="radio" name="access" value="write" defaultChecked className="mt-1" />
              <span>
                <span className="text-foreground">Read and write</span>
                <span className="block text-xs text-muted-foreground">
                  Also add notes, meetings, reminders, summaries and unsent drafts
                </span>
              </span>
            </label>
          ) : null}
        </fieldset>

        {params.problem ? (
          <p className="text-sm text-red-600 dark:text-red-400">{params.problem}</p>
        ) : null}

        <div className="flex gap-2 pt-1">
          <Button type="submit" name="decision" value="approve" className="h-10 flex-1">
            Connect
          </Button>
          <Button type="submit" name="decision" value="deny" variant="outline" className="h-10 flex-1">
            Cancel
          </Button>
        </div>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-sm">{children}</div>
    </main>
  );
}
