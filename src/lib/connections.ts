/**
 * Shared shape for the three Settings → Accounts connectors.
 *
 * "Connected" is always *derived* — a connector is connected iff it has
 * produced a run. No credential is stored in this app: LinkedIn drives the
 * user's logged-in Chrome, Messages reads a local SQLite file, and Gmail's
 * refresh token lives in ~/.mesh-replica/ on the Mac. Nothing here is a secret,
 * so nothing here needs revoking.
 *
 * These types live outside settings-dialog.tsx on purpose — the server action
 * used to import its own return type from a client component.
 */

import { Mail, MessageSquare, type LucideIcon } from "lucide-react";

export type ConnectionKey = "linkedin" | "gmail" | "messages";

export type ConnectionStatus = {
  key: ConnectionKey;
  lastSyncAt: string | null;
  /** Rendered into the 3-up grid; keep to exactly three for the layout. */
  stats: { label: string; value: number }[];
};

export type ConnectionMeta = {
  key: ConnectionKey;
  label: string;
  /**
   * Text in the brand square, two chars max. lucide-react carries no brand
   * icons, so LinkedIn is drawn as its wordmark; the other two use a generic
   * icon instead.
   */
  mark: string | null;
  icon: LucideIcon | null;
  /** Tailwind background for the brand square. */
  markClass: string;
  /** Help line under the stats. */
  hint: string;
};

export const CONNECTIONS: ConnectionMeta[] = [
  {
    key: "linkedin",
    label: "LinkedIn",
    mark: "in",
    icon: null,
    markClass: "bg-[#0a66c2] text-white",
    hint: "Syncing runs from Claude Code using your logged-in Chrome — ask it to “sync LinkedIn”. There is no API key or password stored here.",
  },
  {
    key: "gmail",
    label: "Gmail",
    mark: null,
    icon: Mail,
    markClass: "bg-[#ea4335] text-white",
    hint: "Pair once with “npx tsx scripts/pair-gmail.ts” — the token stays on this Mac, never in this database. Then ask Claude Code to “sync Gmail”. Only dates and counts are read; subjects and message bodies are never requested.",
  },
  {
    key: "messages",
    label: "Messages",
    mark: null,
    icon: MessageSquare,
    markClass: "bg-[#34c759] text-white",
    hint: "Reads a copy of this Mac’s Messages database — ask Claude Code to “sync Messages”. Needs Full Disk Access granted to your terminal. Only dates and counts leave the machine.",
  },
];

/** People found by a connector who aren't in the CRM yet land here first. */
export const DISCOVERED_HREF = "/people?tab=discovered";
