"use client";

import { useState, useTransition } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MCP_TOOLS } from "@/lib/mcp-manifest";
import type { McpAccess } from "@/db/schema";
import type { IdentityView } from "@/lib/mcp-agents";
import {
  createAgent,
  createAgentToken,
  revokeAgent,
  revokeAgentConnection,
  revokeAgentToken,
  updateAgentAccess,
  type TokenResult,
} from "@/lib/actions/mcp-agents";

const ago = (d: Date | string | null) =>
  d ? `${formatDistanceToNowStrict(new Date(d))} ago` : "never";

function useOrigin() {
  return typeof window !== "undefined" ? window.location.origin : "";
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="shrink-0 rounded-md border border-border px-2 py-1 text-[11.5px] text-foreground hover:bg-muted"
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** Shown once, right after minting — the only time a token exists outside the caller's config. */
function TokenBox({ token, agentKey }: { token: string; agentKey: string }) {
  const origin = useOrigin();
  const command = `claude mcp add --transport http rontext ${origin}/api/mcp --header "Authorization: Bearer ${token}"`;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/40">
      <p className="text-[11.5px] font-semibold text-amber-800 dark:text-amber-200">
        Token for {agentKey} — shown once, copy it now.
      </p>
      <div className="flex items-center gap-2 pt-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{token}</code>
        <Copy text={token} label="Copy token" />
      </div>
      <div className="flex items-center gap-2 pt-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">{command}</code>
        <Copy text={command} label="Copy command" />
      </div>
    </div>
  );
}

/** Access level plus an optional tool allowlist — shared by create and edit. */
function AccessFields({
  access,
  setAccess,
  tools,
  setTools,
}: {
  access: McpAccess;
  setAccess: (a: McpAccess) => void;
  tools: string[] | null;
  setTools: (t: string[] | null) => void;
}) {
  const visible = MCP_TOOLS.filter((t) => access === "write" || t.kind === "read");
  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <div className="flex gap-4">
        {(["read", "write"] as const).map((a) => (
          <label key={a} className="flex items-center gap-1.5">
            <input type="radio" checked={access === a} onChange={() => setAccess(a)} />
            {a === "read" ? "Read only" : "Read and write"}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={tools !== null}
          onChange={(e) => setTools(e.target.checked ? visible.map((t) => t.name) : null)}
        />
        Limit to specific tools
      </label>
      {tools !== null ? (
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 pl-5 sm:grid-cols-2">
          {visible.map((t) => (
            <label key={t.name} className="flex items-center gap-1.5 font-mono text-[11.5px]">
              <input
                type="checkbox"
                checked={tools.includes(t.name)}
                disabled={t.name === "report_agent_run"}
                onChange={(e) =>
                  setTools(e.target.checked ? [...tools, t.name] : tools.filter((x) => x !== t.name))
                }
              />
              {t.name}
            </label>
          ))}
          <p className="col-span-full pt-1 text-[11px] text-muted-foreground">
            report_agent_run is always allowed, so every agent can check in.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** How to connect: claude.ai by OAuth, anything else with a minted token. */
export function ConnectAgents() {
  const origin = useOrigin();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const [access, setAccess] = useState<McpAccess>("read");
  const [tools, setTools] = useState<string[] | null>(null);
  const [result, setResult] = useState<TokenResult | null>(null);
  const [pending, start] = useTransition();

  return (
    <section className="rounded-xl border border-border bg-background px-5 py-4">
      <h2 className="text-[14px] font-semibold text-foreground">Connect an agent</h2>
      <div className="flex flex-col gap-3 pt-2 text-[12.5px] leading-relaxed text-muted-foreground">
        <div>
          <p>
            <span className="font-medium text-foreground">Claude (claude.ai, Routines):</span> add a custom
            connector with this URL. Claude sends you here to name the agent and choose its access.
          </p>
          <div className="flex items-center gap-2 pt-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{origin}/api/mcp</code>
            <Copy text={`${origin}/api/mcp`} label="Copy URL" />
          </div>
        </div>
        <div>
          <p>
            <span className="font-medium text-foreground">Claude Code, scheduled tasks, scripts:</span> create
            an agent with its own token.
          </p>
          {!open ? (
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setOpen(true)}>
              New agent token
            </Button>
          ) : (
            <form
              className="flex flex-col gap-3 pt-2"
              onSubmit={(e) => {
                e.preventDefault();
                start(async () => {
                  const r = await createAgent({ key, access, tools, note });
                  setResult(r);
                  if (r.ok) {
                    setKey("");
                    setNote("");
                    setTools(null);
                    setOpen(false);
                  }
                });
              }}
            >
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value.toLowerCase())}
                placeholder="agent name, e.g. wispr-meetings"
                className="h-9 font-mono text-[12.5px]"
                required
              />
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What it's for (optional)"
                className="h-9 text-[12.5px]"
              />
              <AccessFields access={access} setAccess={setAccess} tools={tools} setTools={setTools} />
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={pending || !key}>
                  {pending ? "Creating…" : "Create and show token"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {result && !result.ok ? (
            <p className="pt-2 text-red-600 dark:text-red-400">{result.error}</p>
          ) : null}
          {result?.ok ? (
            <div className="pt-2">
              <TokenBox token={result.token} agentKey={result.key} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** One agent's identity: access, credentials, and the controls to change or cut them. */
export function IdentityPanel({ identity: a, readOnly }: { identity: IdentityView; readOnly: boolean }) {
  const [editing, setEditing] = useState(false);
  const [access, setAccess] = useState<McpAccess>(a.access);
  const [tools, setTools] = useState<string[] | null>(a.tools);
  const [minted, setMinted] = useState<TokenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : (r.error ?? "Something went wrong"));
    });

  if (a.revokedAt) {
    return (
      <p className="px-5 pt-3 text-[12px] text-muted-foreground">
        Access revoked {ago(a.revokedAt)} — its credentials no longer work.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-5 pt-3 text-[12px]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-muted-foreground">Access</span>
        <span className="text-foreground">{a.access === "write" ? "Read and write" : "Read only"}</span>
        {a.tools ? (
          <span className="font-mono text-[11px] text-muted-foreground">· only {a.tools.join(", ")}</span>
        ) : null}
        {!readOnly && !editing ? (
          <button type="button" onClick={() => setEditing(true)} className="text-[11.5px] underline text-muted-foreground">
            change
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <AccessFields access={access} setAccess={setAccess} tools={tools} setTools={setTools} />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const r = await updateAgentAccess(a.id, access, tools);
                  if (r.ok) setEditing(false);
                  return r;
                })
              }
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {a.connections.map((c) => (
        <div key={c.clientId} className="flex items-baseline gap-2">
          <span className="text-muted-foreground">Connector</span>
          <span className="text-foreground">{c.clientName}</span>
          <span className="text-muted-foreground">· used {ago(c.lastUsedAt)}</span>
          {!readOnly ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => revokeAgentConnection(a.id, c.clientId))}
              className="ml-auto text-[11.5px] text-red-600 hover:underline dark:text-red-400"
            >
              Disconnect
            </button>
          ) : null}
        </div>
      ))}
      {a.tokens.map((t) => (
        <div key={t.id} className="flex items-baseline gap-2">
          <span className="text-muted-foreground">Token</span>
          <span className="font-mono text-foreground">rtx_…{t.hint}</span>
          <span className="text-muted-foreground">· used {ago(t.lastUsedAt)}</span>
          {!readOnly ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => revokeAgentToken(t.id))}
              className="ml-auto text-[11.5px] text-red-600 hover:underline dark:text-red-400"
            >
              Revoke
            </button>
          ) : null}
        </div>
      ))}
      {!a.tokens.length && !a.connections.length ? (
        <p className="text-muted-foreground">No live credentials — it can&apos;t call Rontext until you add one.</p>
      ) : null}

      {!readOnly ? (
        <div className="flex gap-3 pt-1">
          <button
            type="button"
            disabled={pending}
            onClick={() => start(async () => setMinted(await createAgentToken(a.id)))}
            className="text-[11.5px] underline text-muted-foreground"
          >
            New token
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (confirm(`Revoke ${a.key}? Every token and connector it has stops working immediately.`)) {
                run(() => revokeAgent(a.id));
              }
            }}
            className="text-[11.5px] text-red-600 hover:underline dark:text-red-400"
          >
            Revoke agent
          </button>
        </div>
      ) : null}
      {minted?.ok ? <TokenBox token={minted.token} agentKey={minted.key} /> : null}
      {minted && !minted.ok ? <p className="text-red-600 dark:text-red-400">{minted.error}</p> : null}
      {error ? <p className="text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
