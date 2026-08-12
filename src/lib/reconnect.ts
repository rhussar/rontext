/**
 * Who's gone quiet — the shared rule behind Home's "Haven't talked in a
 * while" and Drafts' "People to reach out to". Pulled out on purpose so the
 * two lists can't drift apart; both read from `Settings → Reconnect after`.
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
