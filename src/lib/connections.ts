/**
 * Shared shape for the three Settings → Accounts connectors.
 *
 * "Connected" is always *derived* — a connector is connected iff it has
 * produced a run. No credential is stored in this app: LinkedIn drives the
 * user's logged-in Chrome, Messages reads a local SQLite file, and Gmail's
 * refresh token lives in ~/.mesh-replica/ on the Mac. Nothing here is a secret,
 * so nothing here needs revoking.
 *
 * The scheduled jobs (GitHub, X, photos, backup) are a separate list — see
 * src/lib/jobs/registry.ts and the Automation section of the same panel.
 * They're server-side and keyed by Setup secrets, so they have run status
 * rather than "connected".
 *
 * These types live outside settings-dialog.tsx on purpose — the server action
 * used to import its own return type from a client component.
 */

import { ChartLine, Mail, MessageSquare, Plug, type LucideIcon } from "lucide-react";

export type ConnectionKey = "linkedin" | "gmail" | "messages" | "social" | "mcp";

export type ConnectionStatus = {
  key: ConnectionKey;
  lastSyncAt: string | null;
  /** Rendered into the 3-up grid; keep to exactly three for the layout. */
  stats: { label: string; value: number }[];
  /**
   * Replaces "Not synced yet" when lastSyncAt is null. The MCP card uses it to
   * distinguish "enabled, no agent has called yet" from "disabled — no token",
   * which "Not synced yet" can't express.
   */
  emptyLine?: string;
  /** Second status line under the last-synced one — LinkedIn uses it for the extension's heartbeat. */
  subline?: string;
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
  /** Prefix for the last-activity line; defaults to "Last synced". */
  lastLabel?: string;
};

export const CONNECTIONS: ConnectionMeta[] = [
  {
    key: "linkedin",
    label: "LinkedIn",
    mark: "in",
    icon: null,
    markClass: "bg-[#0a66c2] text-white",
    hint: "The Rontext Chrome extension captures profiles as you browse and visits a few due ones a day (cap in General). Claude Code “sync LinkedIn” still works for batches.",
  },
  {
    key: "gmail",
    label: "Google",
    mark: null,
    icon: Mail,
    markClass: "bg-[#ea4335] text-white",
    hint: "Syncs daily once Google is connected — dates and counts only, never message text. Calendar meetings and Contacts birthdays ride on the same connection.",
  },
  {
    key: "messages",
    label: "Messages",
    mark: null,
    icon: MessageSquare,
    markClass: "bg-[#34c759] text-white",
    hint: "Syncs nightly from your Mac via the launchd agent (scripts/install-mac-agent.sh) — dates and counts only leave this Mac. Its check-ins show under Automation.",
  },
  // One card for all four platforms rather than four near-empty cards — the
  // per-platform detail lives on /social where there's room for it.
  {
    key: "social",
    label: "Social analytics",
    mark: null,
    icon: ChartLine,
    markClass: "bg-violet-500 text-white",
    hint: "GitHub and X refresh automatically (see Automation below). LinkedIn and Instagram: ask Claude Code to “sync social stats”.",
  },
  // Unlike the connectors above, this one is inbound: agents call the app, not
  // the other way around. "Connected" therefore means "an agent has actually
  // called", and the empty state distinguishes enabled from disabled.
  {
    key: "mcp",
    label: "MCP server",
    mark: null,
    icon: Plug,
    markClass: "bg-[#d97757] text-white",
    hint: "Lets AI agents search contacts and write notes, reminders, and drafts — no send, no delete.",
    lastLabel: "Last agent call",
  },
];

/** People found by a connector who aren't in the CRM yet land here first. */
export const DISCOVERED_HREF = "/people?tab=discovered";
