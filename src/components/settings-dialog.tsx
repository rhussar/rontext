"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  AtSign,
  Check,
  ChevronRight,
  Contrast,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { updateSettings } from "@/lib/actions/settings";
import { applyTheme } from "@/lib/theme";
import { ago } from "@/lib/format";
import { ImportButton } from "@/components/import-button";
import {
  CONNECTIONS,
  DISCOVERED_HREF,
  type ConnectionStatus,
} from "@/lib/connections";
import { SETUP_KEYS, SETUP_SKILLS, type SetupStatus } from "@/lib/setup";
import {
  WORKSPACE_COLOR_KEYS,
  WORKSPACE_COLORS,
  workspaceInitial,
  type Settings,
  type Theme,
} from "@/lib/settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Section = "general" | "accounts" | "setup" | "appearance";

const SECTIONS: { key: Section; label: string; icon: typeof SettingsIcon }[] = [
  { key: "general", label: "General", icon: SettingsIcon },
  { key: "accounts", label: "Accounts", icon: AtSign },
  { key: "setup", label: "Setup", icon: KeyRound },
  { key: "appearance", label: "Appearance", icon: Contrast },
];

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  connections,
  setup,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  connections: ConnectionStatus[];
  setup: SetupStatus[];
}) {
  const [section, setSection] = useState<Section>("general");
  const [draft, setDraft] = useState<Settings>(settings);
  const [pending, startTransition] = useTransition();

  function save(patch: Partial<Settings>) {
    setDraft((d) => ({ ...d, ...patch }));
    startTransition(async () => {
      await updateSettings(patch);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader className="sr-only">
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>Workspace preferences</DialogDescription>
      </DialogHeader>
      <DialogContent className="max-w-3xl gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="flex min-h-[26rem] flex-col sm:flex-row">
          {/* Left rail */}
          <nav className="flex shrink-0 gap-1 border-b border-border bg-muted/40 p-2 sm:w-48 sm:flex-col sm:border-b-0 sm:border-r sm:p-3">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={cn(
                  "flex flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13.5px] font-medium transition-colors sm:flex-none",
                  section === s.key
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:bg-background/60",
                )}
              >
                <s.icon className="size-4" />
                {s.label}
              </button>
            ))}
          </nav>

          {/* Panel */}
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            <div className="flex items-center gap-2 pb-4">
              <h2 className="text-[15px] font-semibold text-foreground">
                {SECTIONS.find((s) => s.key === section)!.label}
              </h2>
              {pending ? (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              ) : null}
            </div>

            {section === "general" ? (
              <GeneralPanel draft={draft} save={save} />
            ) : section === "accounts" ? (
              <AccountsPanel
                connections={connections}
                onNavigate={() => onOpenChange(false)}
              />
            ) : section === "setup" ? (
              <SetupPanel setup={setup} />
            ) : (
              <AppearancePanel draft={draft} save={save} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <Label className="text-[13.5px] text-foreground">{label}</Label>
        {hint ? (
          <p className="pt-0.5 text-[12px] text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function GeneralPanel({
  draft,
  save,
}: {
  draft: Settings;
  save: (patch: Partial<Settings>) => void;
}) {
  const [name, setName] = useState(draft.workspaceName);
  return (
    <div className="flex flex-col">
      <Row label="Workspace name" hint="Shown at the top of the sidebar.">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const v = name.trim();
            if (v && v !== draft.workspaceName) save({ workspaceName: v });
            else setName(draft.workspaceName);
          }}
          className="h-8 w-44 text-[13.5px]"
        />
      </Row>

      <Row
        label="Upcoming birthdays"
        hint="How far ahead Home looks for birthdays."
      >
        <NumberField
          value={draft.birthdayWindowDays}
          min={1}
          max={365}
          suffix="days"
          onCommit={(v) => save({ birthdayWindowDays: v })}
        />
      </Row>

      <Row
        label="Reconnect after"
        hint="Silence before someone shows up in “Haven’t talked in a while”."
      >
        <NumberField
          value={draft.reconnectAfterMonths}
          min={1}
          max={120}
          suffix="months"
          onCommit={(v) => save({ reconnectAfterMonths: v })}
        />
      </Row>

      <Row
        label="Default reminder time"
        hint="Time of day new reminders start at."
      >
        <Input
          type="time"
          value={draft.defaultReminderTime}
          onChange={(e) =>
            e.target.value && save({ defaultReminderTime: e.target.value })
          }
          className="h-8 w-32 text-[13.5px]"
        />
      </Row>
    </div>
  );
}

function NumberField({
  value,
  min,
  max,
  suffix,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  suffix: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number.parseInt(draft, 10);
          if (Number.isFinite(n) && n >= min && n <= max) {
            if (n !== value) onCommit(n);
          } else {
            setDraft(String(value)); // reject junk rather than saving it
          }
        }}
        className="h-8 w-20 text-[13.5px]"
      />
      <span className="text-[12.5px] text-muted-foreground">{suffix}</span>
    </div>
  );
}

function AccountsPanel({
  connections,
  onNavigate,
}: {
  connections: ConnectionStatus[];
  onNavigate: () => void;
}) {
  const byKey = new Map(connections.map((c) => [c.key, c]));
  return (
    <div className="flex flex-col gap-3">
      {CONNECTIONS.map((meta) => {
        const status = byKey.get(meta.key);
        if (!status) return null;
        return (
          <ConnectionCard
            key={meta.key}
            meta={meta}
            status={status}
            onNavigate={onNavigate}
          />
        );
      })}
      <ImportButton />
    </div>
  );
}

function ConnectionCard({
  meta,
  status,
  onNavigate,
}: {
  meta: (typeof CONNECTIONS)[number];
  status: ConnectionStatus;
  onNavigate: () => void;
}) {
  // Connected is derived, not stored — a connector is connected once it has
  // produced a run. None of them holds a credential to check.
  const connected = status.lastSyncAt !== null;
  const toReview = status.stats.find((s) => s.label === "To review")?.value ?? 0;

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold",
            meta.markClass,
          )}
        >
          {meta.icon ? <meta.icon className="size-4" /> : meta.mark}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-foreground">{meta.label}</p>
          <p className="text-[12px] text-muted-foreground">
            {status.lastSyncAt
              ? `Last synced ${ago(status.lastSyncAt)}`
              : "Not synced yet"}
          </p>
        </div>
        {connected ? (
          <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
            <Check className="size-3" /> Connected
          </span>
        ) : null}
      </div>

      {connected ? (
        <dl className="grid grid-cols-3 gap-2 pt-3 text-center">
          {status.stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} />
          ))}
        </dl>
      ) : null}

      {toReview > 0 ? (
        <Link
          href={DISCOVERED_HREF}
          onClick={onNavigate}
          className="mt-3 flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60"
        >
          <span>
            {toReview.toLocaleString()} {toReview === 1 ? "person" : "people"} waiting
            to be reviewed
          </span>
          <ChevronRight className="size-3.5" />
        </Link>
      ) : null}

      <p className="pt-3 text-[12px] leading-relaxed text-muted-foreground">
        {meta.hint}
      </p>
    </div>
  );
}

/**
 * The "hand this to someone else" screen: what a fresh install needs, and what
 * this one already has. Values are never sent to the client — `setup` carries
 * presence booleans only.
 */
function SetupPanel({ setup }: { setup: SetupStatus[] }) {
  const present = new Map(setup.map((s) => [s.name, s.present]));

  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="pb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          Keys
        </h3>
        <div className="rounded-xl border border-border">
          {SETUP_KEYS.map((k) => {
            const isSet = present.get(k.name) ?? false;
            // A local-only key is absent in production on purpose, so it is
            // never shown as a problem — only as "set here" or "local only".
            const local = k.scope === "local";
            return (
              <div
                key={k.name}
                className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[12.5px] text-foreground">
                    {k.name}
                  </p>
                  <p className="truncate text-[12px] text-muted-foreground">
                    {k.what}
                    {k.from ? ` · ${k.from}` : ""}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    isSet
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                      : local
                        ? "bg-muted text-muted-foreground"
                        : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
                  )}
                >
                  {isSet ? "Set" : local ? "Local only" : "Missing"}
                </span>
              </div>
            );
          })}
        </div>
        <p className="pt-2 text-[12px] leading-relaxed text-muted-foreground">
          Set in <span className="font-mono">web/.env.local</span>, and on Vercel for
          everything except the local-only ones. Values are never shown here.
        </p>
      </section>

      <section>
        <h3 className="pb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          Skills
        </h3>
        <div className="rounded-xl border border-border">
          {SETUP_SKILLS.map((s) => (
            <div
              key={s.name}
              className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-0"
            >
              <p className="shrink-0 font-mono text-[12.5px] text-foreground">
                /{s.name}
              </p>
              <p className="min-w-0 flex-1 truncate text-right text-[12px] text-muted-foreground">
                {s.what}
              </p>
            </div>
          ))}
        </div>
        <p className="pt-2 text-[12px] leading-relaxed text-muted-foreground">
          Run from <span className="font-mono">web/</span> in Claude Code.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/60 py-2">
      <dd className="text-[15px] font-semibold text-foreground">
        {value.toLocaleString()}
      </dd>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
    </div>
  );
}

const THEMES: { key: Theme; label: string; icon: typeof Sun }[] = [
  { key: "light", label: "Light", icon: Sun },
  { key: "dark", label: "Dark", icon: Moon },
  { key: "system", label: "Automatic", icon: Monitor },
];

function AppearancePanel({
  draft,
  save,
}: {
  draft: Settings;
  save: (patch: Partial<Settings>) => void;
}) {
  const initial = workspaceInitial(draft.workspaceName);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Workspace badge
        </p>
        <div className="flex flex-wrap gap-2">
          {WORKSPACE_COLOR_KEYS.map((key) => (
            <button
              key={key}
              onClick={() => save({ workspaceColor: key })}
              aria-label={key}
              title={key}
              className={cn(
                "flex size-9 items-center justify-center rounded-lg ring-offset-2 ring-offset-background transition-all hover:scale-105",
                WORKSPACE_COLORS[key],
                draft.workspaceColor === key && "ring-2 ring-blue-500",
              )}
            >
              <span className="text-[13px] font-bold text-white">{initial}</span>
            </button>
          ))}
        </div>
        <p className="pt-2 text-[12px] text-muted-foreground">
          The letter follows your workspace name — rename it under General.
        </p>
      </div>

      <div>
        <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Theme
        </p>
        <div className="grid grid-cols-3 gap-2">
          {THEMES.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                applyTheme(t.key);
                save({ theme: t.key });
              }}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl border-2 px-3 py-4 transition-colors",
                draft.theme === t.key
                  ? "border-blue-500 bg-blue-500/5"
                  : "border-border hover:border-muted-foreground/40",
              )}
            >
              <t.icon className="size-5 text-muted-foreground" />
              <span className="text-[13px] font-medium text-foreground">
                {t.label}
              </span>
            </button>
          ))}
        </div>
        <p className="pt-2 text-[12px] text-muted-foreground">
          Automatic follows your device setting.
        </p>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900">
        Dark mode is still being rolled out. The sidebar, people list, and
        dialogs are converted — some other screens will still look light until
        the rest catches up.
      </div>
    </div>
  );
}
