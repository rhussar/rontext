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
    hint: "Ask Claude Code to “sync LinkedIn” — runs in your logged-in Chrome; nothing stored here.",
  },
  {
    key: "gmail",
    label: "Gmail",
    mark: null,
    icon: Mail,
    markClass: "bg-[#ea4335] text-white",
    hint: "Ask Claude Code to “sync Gmail” — dates and counts only, never message text.",
  },
  {
    key: "messages",
    label: "Messages",
    mark: null,
    icon: MessageSquare,
    markClass: "bg-[#34c759] text-white",
    hint: "Ask Claude Code to “sync Messages” — dates and counts only leave this Mac.",
  },
  // One card for all four platforms rather than four near-empty cards — the
  // per-platform detail lives on /social where there's room for it.
  {
    key: "social",
    label: "Social analytics",
    mark: null,
    icon: ChartLine,
    markClass: "bg-violet-500 text-white",
    hint: "Ask Claude Code to “sync social stats” — own-account numbers for the Social page.",
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
