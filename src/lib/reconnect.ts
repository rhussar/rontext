/**
 * Who's gone quiet, per `Settings → Reconnect after`.
 *
 * No screen renders this today: Drafts' "People to reach out to" card was
 * removed on request, and the Home list the older comment here claimed had
 * gone years before that. The one live consumer is the MCP tool
 * `list_reconnect_suggestions`, so the rule stays in its own module rather
 * than folded into a component.
 */

import type { PersonRow } from "@/lib/actions/contacts";

export function reconnectSuggestions(
  people: PersonRow[],
  reconnectAfterMonths: number,
  limit = 15,
): PersonRow[] {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - reconnectAfterMonths);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  return people
    .filter(
      (p) =>
        !p.archived &&
        p.lastInteractionDate &&
        p.lastInteractionDate < cutoffIso &&
        !/^\+?\d/.test(p.fullName) && // skip phone-number-only contacts
        (p.company || p.hasLinkedin || p.hasNotes || p.starred),
    )
    .sort((a, b) => a.lastInteractionDate!.localeCompare(b.lastInteractionDate!))
    .slice(0, limit);
}
