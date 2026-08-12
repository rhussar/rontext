"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  AtSign,
  Check,
  ChevronRight,
  Contrast,
  Copy,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { updateSettings } from "@/lib/actions/settings";
import { getSocialProfiles, saveSocialProfile } from "@/lib/actions/social";
import type { PlatformProfile, ProfilePlatform } from "@/lib/social";
import { downscaleImage } from "@/lib/image-downscale";
import { PhotoPicker } from "@/components/photo-picker";
import { PersonAvatar } from "@/components/person-avatar";
import { applyTheme } from "@/lib/theme";
import { ago } from "@/lib/format";
import { ImportButton } from "@/components/import-button";
import {
  CONNECTIONS,
  DISCOVERED_HREF,
  type ConnectionStatus,
} from "@/lib/connections";
import { SETUP_KEYS, type KeyScope, type SetupKey, type SetupStatus } from "@/lib/setup";
import { clearSecret, generateMcpToken, setSecret } from "@/lib/actions/secrets";
import { copyText } from "@/lib/clipboard-text";
import type { SkillSummary } from "@/lib/skill-types";
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
  skills,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  connections: ConnectionStatus[];
  setup: SetupStatus[];
  skills: SkillSummary[];
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
      {/* grid-rows-[minmax(0,1fr)]: the popup is a grid, and an auto row is
          sized to max-content, so without this the panel is clipped by the
          height cap instead of shrinking and scrolling. */}
      <DialogContent className="max-h-[90dvh] max-w-3xl grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {/* Fixed at 39rem — roughly the tallest panels (Accounts/Setup) — so
            the dialog stays the same size on every section instead of resizing
            as you switch. Shorter sections (General) show whitespace below,
            which beats the dialog jumping; longer ones scroll inside the
            panel. The min() keeps it from outgrowing a short viewport. */}
        <div className="flex h-[min(39rem,90dvh)] flex-col overflow-hidden sm:flex-row">
          {/* Left rail */}
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-muted/40 p-2 sm:w-48 sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-r sm:p-3">
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
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
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
              <SetupPanel setup={setup} skills={skills} />
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

/**
 * Per-platform identity rows for the Social post previews. Records live in
 * app_state (one JSON row per platform, avatar as a data URL) — not in
 * Settings, which rides along on every page load — so they load lazily when
 * General opens, same pattern as AccountsPanel's import history.
 */
const PROFILE_ROWS: {
  key: ProfilePlatform;
  label: string;
  bioLabel: string;
  handleHint: string;
  usedFor: string;
}[] = [
  {
    key: "linkedin",
    label: "LinkedIn",
    bioLabel: "Headline",
    handleHint: "Profile slug (optional)",
    usedFor: "Shown on LinkedIn previews.",
  },
  {
    key: "x",
    label: "X",
    bioLabel: "Bio",
    handleHint: "Without the @",
    usedFor: "Shown on X previews.",
  },
  {
    key: "instagram",
    label: "Instagram",
    bioLabel: "Bio",
    handleHint: "Without the @",
    usedFor: "Shown on Instagram previews.",
  },
  {
    key: "youtube",
    label: "YouTube",
    bioLabel: "Channel description",
    handleHint: "Without the @",
    usedFor: "Stored for later.",
  },
];

/** Brand marks, local because PlatformMark's type has no YouTube. */
function ProfileMark({ platform }: { platform: ProfilePlatform }) {
  const base =
    "flex size-5 shrink-0 items-center justify-center rounded-[4px] font-bold text-white";
  if (platform === "linkedin")
    return <span className={cn(base, "bg-[#0a66c2] text-[9px]")}>in</span>;
  if (platform === "x")
    return (
      <span className={cn(base, "bg-black text-[10px] dark:bg-white dark:text-black")}>
        𝕏
      </span>
    );
  if (platform === "instagram")
    return (
      <span
        className={cn(base, "text-[9px]")}
        style={{
          background:
            "radial-gradient(circle at 30% 110%, #fdf497 0%, #fd5949 45%, #d6249f 60%, #285aeb 90%)",
        }}
      >
        Ig
      </span>
    );
  return <span className={cn(base, "bg-[#ff0000] text-[9px]")}>▶</span>;
}

function SocialProfilesSection() {
  const [profiles, setProfiles] = useState<Record<
    ProfilePlatform,
    PlatformProfile
  > | null>(null);
  const [open, setOpen] = useState<ProfilePlatform | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSocialProfiles().then((p) => {
      if (!cancelled) setProfiles(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!profiles) {
    return (
      <div className="py-3 text-[12.5px] text-muted-foreground">Loading…</div>
    );
  }

  return (
    <div className="flex flex-col">
      {PROFILE_ROWS.map((row) => {
        const profile = profiles[row.key];
        const summary = [
          profile.name,
          profile.handle ? `@${profile.handle}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            key={row.key}
            className="border-b border-border py-3 last:border-0"
          >
            <div className="flex items-center gap-2.5">
              <ProfileMark platform={row.key} />
              <div className="min-w-0 flex-1">
                <span className="text-[13.5px] text-foreground">{row.label}</span>
                <p className="truncate text-[12px] text-muted-foreground">
                  {summary || "Not set up"}
                </p>
              </div>
              <PersonAvatar
                name={profile.name || "You"}
                photoSrc={profile.avatar}
                className="size-7"
              />
              <button
                type="button"
                onClick={() => setOpen(open === row.key ? null : row.key)}
                className="rounded-md border border-border px-2.5 py-1 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted"
              >
                {open === row.key ? "Close" : "Edit"}
              </button>
            </div>
            {open === row.key ? (
              <ProfileEditor
                platform={row.key}
                meta={row}
                profile={profile}
                onSaved={(p) => {
                  setProfiles({ ...profiles, [row.key]: p });
                  setOpen(null);
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ProfileEditor({
  platform,
  meta,
  profile,
  onSaved,
}: {
  platform: ProfilePlatform;
  meta: (typeof PROFILE_ROWS)[number];
  profile: PlatformProfile;
  onSaved: (profile: PlatformProfile) => void;
}) {
  const [name, setName] = useState(profile.name);
  const [handle, setHandle] = useState(profile.handle);
  const [bio, setBio] = useState(profile.bio);
  /** Photo staged locally; nothing persists until Save. */
  const [avatarPreview, setAvatarPreview] = useState<string | null>(profile.avatar);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const fd = new FormData();
      fd.set("name", name);
      fd.set("handle", handle);
      fd.set("bio", bio);
      if (pendingPhoto) fd.set("file", pendingPhoto);
      else if (removePhoto) fd.set("removeAvatar", "1");
      const res = await saveSocialProfile(platform, fd);
      if (res.ok) {
        toast.success(`${meta.label} profile saved`);
        onSaved(res.profile);
      } else {
        toast.error(res.error);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-lg bg-muted/60 p-3">
      <div className="flex items-center gap-3">
        <PhotoPicker
          name={name || "You"}
          src={avatarPreview}
          className="size-12"
          textClass="text-[15px]"
          onPicked={async (image) => {
            if (image.kind !== "file") {
              toast.error("Upload or paste an image file.");
              return;
            }
            // 128px is plenty for a feed avatar and keeps the row tiny.
            const scaled = await downscaleImage(image.file, 128, 150_000);
            if (!scaled) {
              toast.error("Couldn't read that image.");
              return;
            }
            setPendingPhoto(scaled.file);
            setAvatarPreview(scaled.previewUrl);
            setRemovePhoto(false);
          }}
          onRemoved={
            avatarPreview
              ? () => {
                  setPendingPhoto(null);
                  setAvatarPreview(null);
                  setRemovePhoto(true);
                }
              : undefined
          }
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="h-8 text-[13.5px]"
          />
          <Input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder={meta.handleHint}
            className="h-8 text-[13.5px]"
          />
        </div>
      </div>
      <textarea
        value={bio}
        onChange={(e) => setBio(e.target.value)}
        placeholder={meta.bioLabel}
        rows={2}
        className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-input"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={submit}
          className="rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-opacity disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <span className="text-[11.5px] text-muted-foreground">{meta.usedFor}</span>
      </div>
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
      {/* Identity for the Social page's post previews — lives here rather than
          General because it's account-shaped: per-platform records with photo,
          name, handle and bio. */}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Your profiles
      </p>
      <SocialProfilesSection />

      <p className="pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Connections
      </p>
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
              ? `${meta.lastLabel ?? "Last synced"} ${ago(status.lastSyncAt)}`
              : (status.emptyLine ?? "Not synced yet")}
          </p>
        </div>
        {connected ? (
          <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
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
 * Setup is where keys get *managed*, not just observed. Integration keys are
 * editable: values go straight to the server action and are stored write-only
 * (never displayed again — pills show only presence and provenance). Bootstrap
 * keys are env-only status rows: they can't live in the database they unlock.
 */
function SetupPanel({
  setup,
  skills,
}: {
  setup: SetupStatus[];
  skills: SkillSummary[];
}) {
  // Local copy so a save's returned SetupStatus[] lands instantly. Re-synced
  // when the layout's RSC refresh delivers a new prop — during render, not in
  // an effect (React's "adjusting state when a prop changes" pattern; an
  // effect here would render one stale frame and trip the lint rule).
  const [status, setStatus] = useState(setup);
  const [prevSetup, setPrevSetup] = useState(setup);
  if (setup !== prevSetup) {
    setPrevSetup(setup);
    setStatus(setup);
  }
  const byName = new Map(status.map((s) => [s.name, s]));

  const bootstrap = SETUP_KEYS.filter((k) => k.scope === "bootstrap");
  const xKeys = SETUP_KEYS.filter((k) => k.name.startsWith("X_"));
  const integrations = SETUP_KEYS.filter(
    (k) => k.scope !== "bootstrap" && !k.name.startsWith("X_"),
  );

  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="pb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          Environment
        </h3>
        <div className="rounded-xl border border-border">
          {bootstrap.map((k) => (
            <div
              key={k.name}
              className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[12.5px] text-foreground">
                  {k.name}
                </p>
                <p className="truncate text-[12px] text-muted-foreground">{k.what}</p>
              </div>
              <StatusPill status={byName.get(k.name)} scope="bootstrap" />
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="pb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          Integrations
        </h3>
        <div className="rounded-xl border border-border">
          {integrations.map((k) => (
            <KeyRow
              key={k.name}
              k={k}
              status={byName.get(k.name)}
              onSaved={setStatus}
            />
          ))}
          <XGroupRow keys={xKeys} byName={byName} onSaved={setStatus} />
        </div>
      </section>

      <section>
        <h3 className="pb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          Skills
        </h3>
        {skills.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            None found on disk — see{" "}
            <span className="font-mono">web/.claude/skills</span>.
          </p>
        ) : (
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
        )}
        <p className="pt-2 text-[12px] text-muted-foreground">
          Run from <span className="font-mono">web/</span> in Claude Code.
        </p>
      </section>
    </div>
  );
}

function StatusPill({
  status,
  scope,
}: {
  status: SetupStatus | undefined;
  scope: KeyScope;
}) {
  const source = status?.source ?? null;
  const label =
    source === "app" ? "Set here" : source === "env" ? "Set in env" : scope === "local" ? "CLI only" : "Missing";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        source
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
          : scope === "local"
            ? "bg-muted text-muted-foreground"
            : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
      )}
    >
      {label}
    </span>
  );
}

const rowButton =
  "shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

/**
 * One editable key. The input is write-only by construction: it is never
 * prefilled (there is no action that could read the value back), and saving
 * routes through setSecret which stores and returns only status.
 */
function KeyRow({
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
  // MCP only: the one-time reveal after Generate. Component state, so closing
  // the dialog discards it — by design, it is shown exactly once.
  const [reveal, setReveal] = useState<string | null>(null);
  const source = status?.source ?? null;
  const isMcp = k.name === "MCP_TOKEN";

  async function submit() {
    if (busy) return;
    setBusy(true);
    const r = await setSecret(k.name, value);
    setBusy(false);
    if (r.ok) {
      onSaved(r.setup);
      setEditing(false);
      setValue("");
      toast.success(`${k.name} saved`);
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
      toast.success(`${k.name} cleared`);
    } else {
      toast.error(r.error);
    }
  }

  async function generate() {
    if (busy) return;
    setBusy(true);
    const r = await generateMcpToken();
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
    <div className="border-b border-border px-3.5 py-2.5 last:border-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[12.5px] text-foreground">{k.name}</p>
          <p className="truncate text-[12px] text-muted-foreground">{k.what}</p>
        </div>
        <StatusPill status={status} scope={k.scope} />
        {isMcp ? (
          <button className={rowButton} onClick={generate} disabled={busy}>
            Generate
          </button>
        ) : null}
        <button
          className={rowButton}
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
          <button className={rowButton} onClick={clear} disabled={busy}>
            Clear
          </button>
        ) : null}
      </div>

      {editing ? (
        <form
          className="flex items-center gap-2 pt-2"
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
            placeholder={k.from ? `Paste value · from ${k.from}` : "Paste value"}
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

      {reveal ? <McpTokenReveal token={reveal} /> : null}
    </div>
  );
}

/**
 * Shown exactly once, right after Generate — the only moment the token is ever
 * displayed. Includes the ready-to-paste connect command so the Accounts card
 * doesn't have to carry it as permanent prose.
 */
function McpTokenReveal({ token }: { token: string }) {
  const command = `claude mcp add --transport http rontext ${
    typeof window !== "undefined" ? window.location.origin : ""
  }/api/mcp --header "Authorization: Bearer ${token}"`;
  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/40">
      <p className="text-[11.5px] font-semibold text-amber-800 dark:text-amber-200">
        Shown once — copy it now.
      </p>
      <div className="flex items-center gap-2 pt-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">
          {token}
        </code>
        <CopyChip text={token} label="Copy token" />
      </div>
      <div className="flex items-center gap-2 pt-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
          {command}
        </code>
        <CopyChip text={command} label="Copy command" />
      </div>
    </div>
  );
}

function CopyChip({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={cn(rowButton, "flex items-center gap-1")}
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
 * The four X OAuth values collapse into one row — separately they'd be a third
 * of the panel while carrying one decision. Amber only when *partially* set:
 * zero keys is a feature not configured, a partial set is genuinely broken.
 */
function XGroupRow({
  keys: xKeys,
  byName,
  onSaved,
}: {
  keys: SetupKey[];
  byName: Map<string, SetupStatus>;
  onSaved: (setup: SetupStatus[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const setCount = xKeys.filter((k) => byName.get(k.name)?.present).length;
  // Only DB-stored keys are clearable — same rule as the single-key rows.
  const appKeys = xKeys.filter((k) => byName.get(k.name)?.source === "app");

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
      toast.success("X keys cleared");
    } else if (last) {
      toast.error(last.error);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const entries = xKeys
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
      toast.success("X keys saved");
    } else if (last) {
      toast.error(last.error);
    }
  }

  return (
    <div className="border-b border-border px-3.5 py-2.5 last:border-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[12.5px] text-foreground">Posting to X</p>
          <p className="truncate text-[12px] text-muted-foreground">
            Four OAuth values, set together
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            setCount === 4
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
              : setCount === 0
                ? "bg-muted text-muted-foreground"
                : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
          )}
        >
          {setCount === 4 ? "Set" : setCount === 0 ? "Not set" : `Set — ${setCount} of 4`}
        </span>
        <button className={rowButton} onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : "Edit"}
        </button>
        {appKeys.length ? (
          <button className={rowButton} onClick={clearAll} disabled={busy}>
            Clear
          </button>
        ) : null}
      </div>

      {open ? (
        <form className="flex flex-col gap-2 pt-2" onSubmit={submit}>
          {xKeys.map((k) => (
            <div key={k.name} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate font-mono text-[11.5px] text-muted-foreground">
                {k.name}
              </span>
              <Input
                type="password"
                autoComplete="off"
                value={values[k.name] ?? ""}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [k.name]: e.target.value }))
                }
                placeholder={byName.get(k.name)?.present ? "Unchanged" : "Paste value"}
                className="h-8 flex-1 font-mono text-[12.5px]"
              />
            </div>
          ))}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || !Object.values(values).some((v) => v.trim())}
              className="h-8 shrink-0 rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <p className="text-[11.5px] text-muted-foreground">
              Generate under Read and write, or posts 403. From developer.x.com.
            </p>
          </div>
        </form>
      ) : null}
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

    </div>
  );
}
