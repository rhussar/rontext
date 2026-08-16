/**
 * One row per integration for Settings → Connections.
 *
 * This exists to kill a specific problem: an integration used to be spread over
 * four places — its stats in Accounts, its keys in Setup, its schedule in
 * Automation, and (for LinkedIn and photos) a knob in General. Every surface
 * then had to explain where the other three were, which is where most of the
 * panel's prose came from. One entry here owns all of it, so a card can be read
 * without following a cross-reference.
 *
 * Client-safe: types and constants only, no runtime imports from the server.
 */

import {
  Image as ImageIcon,
  Mail,
  MessageSquare,
  Plug,
  Save,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { ConnectionKey } from "@/lib/connections";

/** Which machine actually runs it — drives the badge and whether "Sync now" exists. */
export type RunsOn = "vercel" | "mac" | "chrome";

/** The one General setting an integration owns, if any. */
export type IntegrationSetting = "linkedinDailyVisits" | "photoMonthlyBudgetUsd";

export type IntegrationDef = {
  id: string;
  label: string;
  /**
   * One short line, present tense, describing what it does for you — never
   * where to configure it. If a line needs to point at another screen, the
   * layout is wrong.
   */
  blurb: string;
  icon: LucideIcon | null;
  /** Text mark for brands lucide has no icon for. */
  mark: string | null;
  markClass: string;
  runsOn: RunsOn;
  /** Stats card to fold in, when this integration has one. */
  connection?: ConnectionKey;
  /**
   * Jobs belonging to this integration. "Sync now" runs them in order; the
   * newest run across all of them is what the row reports.
   */
  jobs: string[];
  /** Secrets configured inside this row, in display order. */
  keys: string[];
  /** True when the keys are an all-or-nothing set (X's four OAuth values). */
  keysAllOrNothing?: boolean;
  setting?: IntegrationSetting;
};

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "google",
    label: "Google",
    blurb: "Who you email, who you meet, and birthdays from your contacts",
    icon: Mail,
    mark: null,
    markClass: "bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400",
    runsOn: "vercel",
    connection: "gmail",
    jobs: ["gmail", "google-calendar", "google-contacts"],
    keys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    blurb: "Headline and job changes from profiles you browse",
    icon: null,
    mark: "in",
    markClass: "bg-[#0a66c2] text-white",
    runsOn: "chrome",
    connection: "linkedin",
    jobs: ["linkedin"],
    keys: ["EXTENSION_TOKEN"],
    setting: "linkedinDailyVisits",
  },
  {
    id: "messages",
    label: "Messages",
    blurb: "iMessage and SMS history — counts and dates only",
    icon: MessageSquare,
    mark: null,
    markClass: "bg-green-100 text-green-600 dark:bg-green-950/50 dark:text-green-400",
    runsOn: "mac",
    connection: "messages",
    jobs: ["messages"],
    keys: [],
  },
  {
    id: "github",
    label: "GitHub",
    blurb: "Followers, stars and repo traffic",
    icon: null,
    mark: "GH",
    markClass: "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900",
    runsOn: "vercel",
    jobs: ["github"],
    keys: ["GITHUB_TOKEN"],
  },
  {
    id: "x",
    label: "X",
    blurb: "Your follower count and recent post metrics",
    icon: null,
    mark: "X",
    markClass: "bg-black text-white dark:bg-white dark:text-black",
    runsOn: "vercel",
    jobs: ["x-metrics"],
    keys: ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"],
    keysAllOrNothing: true,
  },
  {
    id: "photos",
    label: "Contact photos",
    blurb: "Fills in missing profile pictures",
    icon: ImageIcon,
    mark: null,
    markClass: "bg-violet-100 text-violet-600 dark:bg-violet-950/50 dark:text-violet-400",
    runsOn: "vercel",
    jobs: ["photos"],
    keys: ["UNAVATAR_API_KEY"],
    setting: "photoMonthlyBudgetUsd",
  },
  {
    id: "backup",
    label: "Backup",
    blurb: "Nightly snapshot, kept 30 days",
    icon: Save,
    mark: null,
    markClass: "bg-sky-100 text-sky-600 dark:bg-sky-950/50 dark:text-sky-400",
    runsOn: "vercel",
    jobs: ["backup"],
    keys: ["BLOB_READ_WRITE_TOKEN"],
  },
  {
    id: "ai",
    label: "AI drafting",
    blurb: "Writes outreach drafts in your voice",
    icon: Sparkles,
    mark: null,
    markClass: "bg-amber-100 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400",
    runsOn: "vercel",
    jobs: [],
    keys: ["ANTHROPIC_API_KEY"],
  },
  {
    id: "mcp",
    label: "AI agent access",
    blurb: "Lets Claude read contacts and write notes, reminders and drafts",
    icon: Plug,
    mark: null,
    markClass: "bg-orange-100 text-orange-600 dark:bg-orange-950/50 dark:text-orange-400",
    runsOn: "vercel",
    connection: "mcp",
    jobs: [],
    keys: ["MCP_TOKEN"],
  },
];

/**
 * Keys the app needs to boot, shown read-only behind the Advanced disclosure.
 * They can't live in the database they unlock, so there is nothing to edit —
 * only a presence check worth having when something is off.
 */
export const ADVANCED_KEYS = [
  "DATABASE_URL",
  "APP_PASSCODE",
  "SESSION_SECRET",
  "CRON_SECRET",
];
