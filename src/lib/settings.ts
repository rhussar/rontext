export type Theme = "light" | "dark" | "system";

/** Preset looks for the workspace badge in the sidebar. */
export const WORKSPACE_COLORS = {
  aurora: "bg-gradient-to-br from-emerald-300 via-sky-300 to-violet-300",
  sunset: "bg-gradient-to-br from-amber-300 via-orange-400 to-rose-400",
  ocean: "bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600",
  forest: "bg-gradient-to-br from-lime-300 via-emerald-400 to-teal-600",
  berry: "bg-gradient-to-br from-fuchsia-400 via-purple-500 to-indigo-600",
  ember: "bg-gradient-to-br from-rose-400 via-red-500 to-orange-500",
  graphite: "bg-gradient-to-br from-stone-400 via-stone-500 to-stone-700",
} as const;

export type WorkspaceColor = keyof typeof WORKSPACE_COLORS;

export const WORKSPACE_COLOR_KEYS = Object.keys(
  WORKSPACE_COLORS,
) as WorkspaceColor[];

/**
 * First letter of the workspace name — "Ronan's Workspace" → "R". Skips
 * punctuation so a name like "@home" still yields a letter.
 */
export function workspaceInitial(name: string): string {
  const match = (name ?? "").match(/[\p{L}\p{N}]/u);
  return (match?.[0] ?? "W").toUpperCase();
}

export type Settings = {
  workspaceName: string;
  /** Which preset paints the sidebar badge. */
  workspaceColor: WorkspaceColor;
  /** Days ahead Home looks for upcoming birthdays. */
  birthdayWindowDays: number;
  /** Months of silence before Home suggests reconnecting. */
  reconnectAfterMonths: number;
  /** "HH:MM" that new reminders default to. */
  defaultReminderTime: string;
  theme: Theme;
};

// Social preview identity is deliberately NOT here: it's per-platform records
// (with avatar data URLs) in app_state under socialProfile:<platform> — see
// getSocialProfiles() in lib/actions/social.ts. Settings ride along on every
// page load; image bytes don't belong in that payload.

export const DEFAULT_SETTINGS: Settings = {
  workspaceName: "My Workspace",
  workspaceColor: "aurora",
  birthdayWindowDays: 30,
  reconnectAfterMonths: 6,
  defaultReminderTime: "10:00",
  theme: "system",
};

const clampInt = (raw: string, min: number, max: number, fallback: number) => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Rows come back as strings; coerce and bound them so a bad value can't break a page. */
export function parseSettings(rows: Record<string, string>): Settings {
  const theme = rows.theme;
  return {
    workspaceName:
      rows.workspaceName?.trim() || DEFAULT_SETTINGS.workspaceName,
    workspaceColor: (WORKSPACE_COLOR_KEYS as string[]).includes(
      rows.workspaceColor ?? "",
    )
      ? (rows.workspaceColor as WorkspaceColor)
      : DEFAULT_SETTINGS.workspaceColor,
    birthdayWindowDays: clampInt(
      rows.birthdayWindowDays ?? "",
      1,
      365,
      DEFAULT_SETTINGS.birthdayWindowDays,
    ),
    reconnectAfterMonths: clampInt(
      rows.reconnectAfterMonths ?? "",
      1,
      120,
      DEFAULT_SETTINGS.reconnectAfterMonths,
    ),
    defaultReminderTime: /^\d{2}:\d{2}$/.test(rows.defaultReminderTime ?? "")
      ? rows.defaultReminderTime
      : DEFAULT_SETTINGS.defaultReminderTime,
    theme:
      theme === "light" || theme === "dark" || theme === "system"
        ? theme
        : DEFAULT_SETTINGS.theme,
  };
}

export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
