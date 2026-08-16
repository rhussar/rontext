"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Contrast,
  Loader2,
  Monitor,
  Moon,
  Plug2,
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
import { ConnectionsPanel } from "@/components/settings-connections";
import type { ConnectionStatus } from "@/lib/connections";
import type { SetupStatus } from "@/lib/setup";
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

type Section = "general" | "connections" | "appearance";

// Three sections, not four. "Accounts" (status) and "Setup" (keys) used to be
// separate, which meant every integration was described twice and each half had
// to point at the other. They're one list now.
const SECTIONS: { key: Section; label: string; icon: typeof SettingsIcon }[] = [
  { key: "general", label: "General", icon: SettingsIcon },
  { key: "connections", label: "Connections", icon: Plug2 },
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
            ) : section === "connections" ? (
              <ConnectionsPanel
                connections={connections}
                setup={setup}
                skills={skills}
                draft={draft}
                save={save}
                onNavigate={() => onOpenChange(false)}
              />
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

      {/* LinkedIn visits/day and the photo budget used to sit here. They belong
          to one integration each, so they live on those cards now — a knob is
          easier to understand next to the thing it throttles. */}

      <p className="pt-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Your profiles
      </p>
      <div className="pt-2">
        <SocialProfilesSection />
      </div>
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
      </div>

    </div>
  );
}
