import type { PersonRow } from "@/lib/actions/contacts";

/** Lower is better; -1 means no match. Shared by the search palette and the merge picker. */
export function scorePersonMatch(person: PersonRow, q: string): number {
  const name = person.fullName.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  // A word starting with the query beats a match buried mid-token
  if (name.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  if ((person.company ?? "").toLowerCase().includes(q)) return 4;
  if ((person.title ?? "").toLowerCase().includes(q)) return 5;
  return -1;
}
