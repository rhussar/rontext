"use client";

/**
 * Settings → Connections: one self-contained row per integration.
 *
 * Replaces the old Accounts + Setup split, where an integration's status,
 * credentials, schedule and one setting each lived on a different screen and
 * every screen had to explain where the others were. A row here answers the
 * only three questions worth asking — is it on, when did it last run, can I run
 * it now — and hides credentials behind the row that uses them.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  Play,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ago } from "@/lib/format";
import { copyText } from "@/lib/clipboard-text";
import { ImportButton } from "@/components/import-button";
import { Input } from "@/components/ui/input";
import {
  getAutomationStatus,
  runJobNow,
  type AutomationRow,
  type AutomationStatus,
} from "@/lib/actions/automation";
import { disconnectGoogle, getGoogleStatus, type GoogleStatus } from "@/lib/actions/google";
import { clearSecret, generateToken, setSecret } from "@/lib/actions/secrets";
import { DISCOVERED_HREF, type ConnectionStatus } from "@/lib/connections";
import { SETUP_KEYS, type SetupKey, type SetupStatus } from "@/lib/setup";
import { INTEGRATIONS, ADVANCED_KEYS, type IntegrationDef } from "@/lib/integrations";
import {
  LINKEDIN_VISITS_MAX,
  PHOTO_BUDGET_MAX,
  type Settings,
} from "@/lib/settings";
import type { SkillSummary } from "@/lib/skill-types";

const KEY_BY_NAME = new Map(SETUP_KEYS.map((k) => [k.name, k]));

const chipButton =
  "shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

export function ConnectionsPanel({
  connections,
  setup,
  skills,
  draft,
  save,
  onNavigate,
}: {
  connections: ConnectionStatus[];
  setup: SetupStatus[];
  skills: SkillSummary[];
  draft: Settings;
  save: (patch: Partial<Settings>) => void;
  onNavigate: () => void;
}) {
  // Local copy so a save's returned SetupStatus[] lands instantly, re-synced
  // during render when the layout's RSC refresh delivers a new prop (an effect
  // here would render one stale frame and trip the purity lint).
  const [status, setStatus] = useState(setup);
  const [prevSetup, setPrevSetup] = useState(setup);
  if (setup !== prevSetup) {
    setPrevSetup(setup);
    setStatus(setup);
  }

  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  // Captured with the status rather than read during render — "stale" only
  // needs judging as of when the panel loaded.
  const [loadedAt, setLoadedAt] = useState(0);
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    getAutomationStatus()
      .then((s) => {
        setAutomation(s);
        setLoadedAt(Date.now());
      })
      .catch(() => setAutomation(null));
  }, []);

  const byName = new Map(status.map((s) => [s.name, s]));
  const byConnection = new Map(connections.map((c) => [c.key, c]));
  const byJob = new Map((automation?.jobs ?? []).map((j) => [j.key, j]));

  /**
   * "Sync now" runs every job the integration owns, in order — Google is three
   * jobs behind one connection, and making the user run them one at a time was
   * exactly the kind of plumbing this panel is meant to hide.
   */
  async function runAll(def: IntegrationDef) {
    const rows = def.jobs
      .map((k) => byJob.get(k as AutomationRow["key"]))
      .filter((r): r is AutomationRow => !!r && r.runsOn === "vercel");
    if (!rows.length) return;
    setRunning(def.id);
    let next: AutomationStatus | null = null;
    const failed: string[] = [];
    try {
      for (const row of rows) {
        next = await runJobNow(row.key);
        const last = next.jobs.find((j) => j.key === row.key)?.last;
        if (last?.status === "failed") failed.push(`${row.label}: ${last.message ?? "failed"}`);
      }
      if (next) setAutomation(next);
      if (failed.length) toast.error(failed.join(" · "));
      else toast.success(`${def.label} synced`);
    } catch {
      toast.error(`Couldn't sync ${def.label}.`);
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {automation && !automation.cronEnabled ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          Nothing runs on a schedule — CRON_SECRET isn’t set on the server.
        </p>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border">
        {INTEGRATIONS.map((def) => (
          <IntegrationRow
            key={def.id}
            def={def}
            connection={def.connection ? byConnection.get(def.connection) : undefined}
            jobs={def.jobs
              .map((k) => byJob.get(k as AutomationRow["key"]))
              .filter((r): r is AutomationRow => !!r)}
            byName={byName}
            onSaved={setStatus}
            loading={!automation}
            loadedAt={loadedAt}
            running={running === def.id}
            anyRunning={running !== null}
            onRun={() => runAll(def)}
            draft={draft}
            save={save}
            onNavigate={onNavigate}
          />
        ))}
      </div>

      <p className="pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Your data
      </p>
      <ImportButton />
      <div className="flex flex-wrap gap-2">
        {/* Plain links, not fetch: the browser sends the session cookie and
            Content-Disposition makes it a download. */}
        <a
          href="/api/export?format=csv"
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent"
        >
          <Download className="size-3.5" /> Export contacts
        </a>
        <a
          href="/api/export?format=json"
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent"
        >
          <Download className="size-3.5" /> Export everything
        </a>
      </div>

      <AdvancedSection byName={byName} skills={skills} />
    </div>
  );
}

/**
 * What one row reports for an integration that owns several jobs.
 *
 * Not simply the newest run: Google is three jobs, and when Gmail syncs nightly
 * while Calendar skips for a missing scope, the newest row is the skip — which
 * would label a working connection "Paused". A failure outranks everything, and
 * one success is enough to call the integration connected; "Paused" is reserved
 * for when nothing succeeded.
 */
function representativeRun(jobs: AutomationRow[]): {
  run: AutomationRow["last"];
  tone: "ok" | "warn" | "bad";
} | null {
  const runs = jobs.map((j) => j.last).filter((l): l is NonNullable<AutomationRow["last"]> => !!l);
  if (!runs.length) return null;
  const newestOf = (status: string) =>
    runs
      .filter((r) => r.status === status)
      .reduce<(typeof runs)[number] | null>(
        (best, r) => (!best || r.startedAt > best.startedAt ? r : best),
        null,
      );
  const failed = newestOf("failed");
  if (failed) return { run: failed, tone: "bad" };
  const ok = newestOf("ok");
  if (ok) return { run: ok, tone: "ok" };
  return { run: newestOf("skipped"), tone: "warn" };
}

function IntegrationRow({
  def,
  connection,
  jobs,
  byName,
  onSaved,
  loading,
  loadedAt,
  running,
  anyRunning,
  onRun,
  draft,
  save,
  onNavigate,
}: {
  def: IntegrationDef;
  connection: ConnectionStatus | undefined;
  jobs: AutomationRow[];
  byName: Map<string, SetupStatus>;
  onSaved: (setup: SetupStatus[]) => void;
  loading: boolean;
  loadedAt: number;
  running: boolean;
  anyRunning: boolean;
  onRun: () => void;
  draft: Settings;
  save: (patch: Partial<Settings>) => void;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const keys = def.keys.map((n) => KEY_BY_NAME.get(n)).filter((k): k is SetupKey => !!k);
  const setCount = keys.filter((k) => byName.get(k.name)?.source).length;
  const configured = keys.length === 0 || setCount === keys.length;

  const rep = representativeRun(jobs);
  const last = rep?.run ?? null;
  // A Mac or Chrome row that hasn't checked in for ~1.5× its interval is stale:
  // the laptop is asleep, the agent isn't installed, or it lost disk access.
  const everyHours = jobs[0]?.everyHours ?? 24;
  const stale =
    def.runsOn !== "vercel" &&
    !!last &&
    loadedAt - new Date(last.startedAt).getTime() > everyHours * 1.5 * 3_600_000;

  const tone = !configured ? "off" : stale ? "bad" : (rep?.tone ?? "ok");

  const stateLabel =
    tone === "off"
      ? "Not set up"
      : tone === "bad"
        ? "Needs attention"
        : tone === "warn"
          ? "Paused"
          : "Connected";

  // One line, and only when it says something the state pill doesn't.
  const detail = last
    ? `${last.status === "ok" ? "Synced" : last.status === "failed" ? "Failed" : "Skipped"} ${ago(last.startedAt)}${
        last.status !== "ok" && last.message ? ` — ${last.message}` : ""
      }${stale ? " · no check-in since" : ""}`
    : configured
      ? def.blurb
      : def.blurb;

  const canRun = jobs.some((j) => j.runsOn === "vercel");
  const toReview = connection?.stats.find((s) => s.label === "To review")?.value ?? 0;

  return (
    <div className="border-b border-border last:border-0">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold",
            def.markClass,
          )}
        >
          {def.icon ? <def.icon className="size-4" /> : def.mark}
        </span>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13.5px] font-medium text-foreground">
            {def.label}
            {def.runsOn !== "vercel" ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                {def.runsOn === "mac" ? "Mac" : "Chrome"}
              </span>
            ) : null}
          </p>
          <p className="truncate text-[12px] text-muted-foreground">
            {loading && def.jobs.length ? "…" : detail}
          </p>
        </div>

        <StateDot tone={tone} label={stateLabel} />

        {canRun ? (
          <button
            type="button"
            onClick={onRun}
            disabled={anyRunning || !configured}
            title={configured ? "Sync now" : "Add the key first"}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
          >
            {running ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Play className="size-3" />
            )}
            Sync
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Hide details" : "Show details"}
          aria-expanded={open}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open ? (
        <div className="flex flex-col gap-3 border-t border-border bg-muted/30 px-3.5 py-3">
          <p className="text-[12px] text-muted-foreground">{def.blurb}</p>

          {connection && connection.lastSyncAt ? (
            <dl className="grid grid-cols-3 gap-2 text-center">
              {connection.stats.map((s) => (
                <div key={s.label} className="rounded-lg bg-background py-2">
                  <dd className="text-[15px] font-semibold text-foreground">
                    {s.value.toLocaleString()}
                  </dd>
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {s.label}
                  </dt>
                </div>
              ))}
            </dl>
          ) : null}

          {toReview > 0 ? (
            <Link
              href={DISCOVERED_HREF}
              onClick={onNavigate}
              className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60"
            >
              <span>
                {toReview.toLocaleString()} {toReview === 1 ? "person" : "people"} to review
              </span>
              <ChevronRight className="size-3.5" />
            </Link>
          ) : null}

          {def.id === "google" ? <GoogleControls /> : null}

          {def.setting === "linkedinDailyVisits" ? (
            <SettingField
              label="Profiles to visit per day"
              value={draft.linkedinDailyVisits}
              min={0}
              max={LINKEDIN_VISITS_MAX}
              suffix="a day"
              onCommit={(v) => save({ linkedinDailyVisits: v })}
            />
          ) : null}
          {def.setting === "photoMonthlyBudgetUsd" ? (
            <SettingField
              label="Monthly spending limit"
              value={draft.photoMonthlyBudgetUsd}
              min={0}
              max={PHOTO_BUDGET_MAX}
              suffix="$ a month"
              onCommit={(v) => save({ photoMonthlyBudgetUsd: v })}
            />
          ) : null}

          {def.keysAllOrNothing && keys.length > 1 ? (
            <KeyGroupField keys={keys} byName={byName} onSaved={onSaved} label={def.label} />
          ) : (
            keys.map((k) => (
              <KeyField key={k.name} k={k} status={byName.get(k.name)} onSaved={onSaved} />
            ))
          )}

          {/* Per-job runs, only when an integration owns more than one — the
              collapsed row already reports the newest. */}
          {jobs.length > 1 ? (
            <ul className="flex flex-col gap-1">
              {jobs.map((j) => (
                <li key={j.key} className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">{j.label}</span>
                  <span className="shrink-0">
                    {j.last
                      ? `${j.last.status} ${ago(j.last.startedAt)}`
                      : "never run"}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StateDot({ tone, label }: { tone: "ok" | "warn" | "bad" | "off"; label: string }) {
  return (
    <span
      className={cn(
        "hidden shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium sm:flex",
        tone === "ok"
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
          : tone === "bad"
            ? "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300"
            : tone === "warn"
              ? "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
              : "bg-muted text-muted-foreground",
      )}
    >
      {tone === "ok" ? <Check className="size-3" /> : null}
      {label}
    </span>
  );
}

/** A whole-number setting that belongs to one integration. */
function SettingField({
  label,
  value,
  min,
  max,
  suffix,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 text-[12.5px] text-foreground">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Math.max(min, Math.min(max, Number(text) || 0));
          setText(String(n));
          if (n !== value) onCommit(n);
        }}
        className="h-8 w-20 text-[13px]"
      />
      <span className="shrink-0 text-[12px] text-muted-foreground">{suffix}</span>
    </div>
  );
}

const GOOGLE_SCOPE_LABEL: Record<GoogleStatus["scopes"][number], string> = {
  gmail: "Gmail",
  calendar: "Calendar",
  contacts: "Contacts",
};

/**
 * Connect / Disconnect for the Google grant. Presence only — the token never
 * comes to the client. Reconnecting is how scopes get added, so the chips show
 * which ones are missing.
 */
function GoogleControls() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getGoogleStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  if (!status) return null;

  const allScopes = Object.keys(GOOGLE_SCOPE_LABEL) as GoogleStatus["scopes"][number][];
  const missing = allScopes.filter((k) => !status.scopes.includes(k));

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-[12.5px] font-medium text-foreground">
        {status.connected ? (status.email ?? "Google account") : "Not connected"}
      </span>
      {status.connected ? (
        <span className="flex flex-wrap gap-1">
          {allScopes.map((k) => (
            <span
              key={k}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                status.scopes.includes(k)
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                  : "bg-muted text-muted-foreground line-through",
              )}
            >
              {GOOGLE_SCOPE_LABEL[k]}
            </span>
          ))}
        </span>
      ) : null}
      <span className="ml-auto flex gap-1.5">
        {status.canConnect ? (
          <a
            href="/api/oauth/google/start"
            className="rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:bg-accent"
          >
            {status.connected ? (missing.length ? "Add Calendar & Contacts" : "Reconnect") : "Connect"}
          </a>
        ) : null}
        {status.connected ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              disconnectGoogle()
                .then((next) => {
                  setStatus(next);
                  toast.success("Google disconnected");
                })
                .catch(() => toast.error("Couldn't disconnect."))
                .finally(() => setBusy(false));
            }}
            className="rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            {busy ? "…" : "Disconnect"}
          </button>
        ) : null}
      </span>
      {status.connected && !status.canConnect ? (
        <p className="basis-full text-[11.5px] text-muted-foreground">
          This grant covers Gmail only. Adding Calendar and Contacts needs a Web OAuth
          client — paste one below, then reconnect.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One editable secret. Write-only by construction: never prefilled (no action
 * can read a value back), and saving routes through setSecret which stores and
 * returns only status.
 */
function KeyField({
  k,
  status,
  onSaved,
}: {
  k: SetupKey;
  status: SetupStatus | undefined;
  onSaved: (setup: SetupStatus[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  // The one-time reveal after Generate. Component state, so closing the dialog
  // discards it — by design, it is shown exactly once.
  const [reveal, setReveal] = useState<string | null>(null);
  const source = status?.source ?? null;
  const isGenerated = k.name === "MCP_TOKEN" || k.name === "EXTENSION_TOKEN";

  async function submit() {
    if (busy) return;
    setBusy(true);
    const r = await setSecret(k.name, value);
    setBusy(false);
    if (r.ok) {
      onSaved(r.setup);
      setEditing(false);
      setValue("");
      toast.success("Saved");
    } else {
      toast.error(r.error);
    }
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    const r = await clearSecret(k.name);
    setBusy(false);
    if (r.ok) {
      onSaved(r.setup);
      setReveal(null);
      toast.success("Cleared");
    } else {
      toast.error(r.error);
    }
  }

  async function generate() {
    if (busy) return;
    setBusy(true);
    const r = await generateToken(k.name);
    setBusy(false);
    if (r.ok) {
      onSaved(r.setup);
      setReveal(r.token);
      setEditing(false);
    } else {
      toast.error(r.error);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-background px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
          {k.name}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
            source
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
              : "bg-muted text-muted-foreground",
          )}
        >
          {source === "app" ? "Set" : source === "env" ? "Set in env" : "Not set"}
        </span>
        {isGenerated ? (
          <button className={chipButton} onClick={generate} disabled={busy}>
            Generate
          </button>
        ) : null}
        <button
          className={chipButton}
          onClick={() => {
            setEditing((e) => !e);
            setValue("");
          }}
        >
          {editing ? "Cancel" : source ? "Replace" : "Add"}
        </button>
        {/* Clear only when the value lives in the DB — an env var can't be
            cleared from a UI, and showing the button would lie. */}
        {source === "app" ? (
          <button className={chipButton} onClick={clear} disabled={busy}>
            Clear
          </button>
        ) : null}
      </div>

      {editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste value"
            className="h-8 flex-1 font-mono text-[12.5px]"
          />
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="h-8 shrink-0 rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      ) : null}

      {editing && k.from ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{k.from}</p>
      ) : null}

      {reveal ? <TokenReveal name={k.name} token={reveal} /> : null}
    </div>
  );
}

/**
 * Several secrets that are one decision — X's four OAuth values. Separately
 * they'd be most of the card while carrying a single choice.
 */
function KeyGroupField({
  keys,
  byName,
  onSaved,
  label,
}: {
  keys: SetupKey[];
  byName: Map<string, SetupStatus>;
  onSaved: (setup: SetupStatus[]) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const setCount = keys.filter((k) => byName.get(k.name)?.source).length;
  const appKeys = keys.filter((k) => byName.get(k.name)?.source === "app");

  async function clearAll() {
    if (busy || !appKeys.length) return;
    setBusy(true);
    let last: Awaited<ReturnType<typeof clearSecret>> | null = null;
    for (const k of appKeys) {
      last = await clearSecret(k.name);
      if (!last.ok) break;
    }
    setBusy(false);
    if (last?.ok) {
      onSaved(last.setup);
      toast.success("Cleared");
    } else if (last) {
      toast.error(last.error);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const entries = keys
      .map((k) => [k.name, values[k.name]?.trim() ?? ""] as const)
      .filter(([, v]) => v);
    if (!entries.length) return;
    setBusy(true);
    let last: Awaited<ReturnType<typeof setSecret>> | null = null;
    for (const [name, v] of entries) {
      last = await setSecret(name, v);
      if (!last.ok) break;
    }
    setBusy(false);
    if (last?.ok) {
      onSaved(last.setup);
      setValues({});
      setOpen(false);
      toast.success("Saved");
    } else if (last) {
      toast.error(last.error);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-background px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[12px] text-muted-foreground">
          {label} API keys
        </span>
        {/* Amber only when *partially* set: none is "not configured", some is broken. */}
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
            setCount === keys.length
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
              : setCount === 0
                ? "bg-muted text-muted-foreground"
                : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
          )}
        >
          {setCount === keys.length
            ? "Set"
            : setCount === 0
              ? "Not set"
              : `${setCount} of ${keys.length}`}
        </span>
        <button className={chipButton} onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : setCount ? "Replace" : "Add"}
        </button>
        {appKeys.length ? (
          <button className={chipButton} onClick={clearAll} disabled={busy}>
            Clear
          </button>
        ) : null}
      </div>

      {open ? (
        <form className="flex flex-col gap-2" onSubmit={submit}>
          {keys.map((k) => (
            <div key={k.name} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                {k.name}
              </span>
              <Input
                type="password"
                autoComplete="off"
                value={values[k.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [k.name]: e.target.value }))}
                placeholder={byName.get(k.name)?.source ? "Unchanged" : "Paste value"}
                className="h-8 flex-1 font-mono text-[12.5px]"
              />
            </div>
          ))}
          <button
            type="submit"
            disabled={busy || !Object.values(values).some((v) => v.trim())}
            className="h-8 w-fit shrink-0 rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * Shown exactly once, right after Generate — the only moment a token is ever
 * displayed. The MCP one carries the ready-to-paste connect command so the row
 * doesn't have to hold it as permanent prose.
 */
function TokenReveal({ name, token }: { name: string; token: string }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const second =
    name === "MCP_TOKEN"
      ? {
          value: `claude mcp add --transport http rontext ${origin}/api/mcp --header "Authorization: Bearer ${token}"`,
          label: "Copy command",
        }
      : { value: origin, label: "Copy app URL" };
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/40">
      <p className="text-[11.5px] font-semibold text-amber-800 dark:text-amber-200">
        {name === "EXTENSION_TOKEN"
          ? "Shown once — paste both into the extension’s options page."
          : "Shown once — copy it now."}
      </p>
      <div className="flex items-center gap-2 pt-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">
          {token}
        </code>
        <CopyChip text={token} label="Copy token" />
      </div>
      <div className="flex items-center gap-2 pt-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
          {second.value}
        </code>
        <CopyChip text={second.value} label={second.label} />
      </div>
    </div>
  );
}

function CopyChip({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={cn(chipButton, "flex items-center gap-1")}
      onClick={async () => {
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {label}
    </button>
  );
}

/**
 * The things you can't act on from here: server-only keys and the Claude Code
 * skills. Collapsed, because needing them means something is already wrong.
 */
function AdvancedSection({
  byName,
  skills,
}: {
  byName: Map<string, SetupStatus>;
  skills: SkillSummary[];
}) {
  return (
    <details className="pt-3">
      <summary className="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
        Advanced
      </summary>
      <div className="flex flex-col gap-3 pt-3">
        <div className="overflow-hidden rounded-xl border border-border">
          {ADVANCED_KEYS.map((name) => {
            const source = byName.get(name)?.source ?? null;
            return (
              <div
                key={name}
                className="flex items-center gap-3 border-b border-border px-3.5 py-2 last:border-0"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
                  {name}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                    source
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                      : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
                  )}
                >
                  {source ? "Set" : "Missing"}
                </span>
              </div>
            );
          })}
        </div>
        {skills.length ? (
          <div className="flex flex-wrap gap-1.5">
            {skills.map((s) => (
              <a
                key={s.name}
                href={`/skills#${s.name}`}
                className="rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-[11.5px] text-foreground transition-colors hover:bg-muted"
              >
                /{s.name}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
