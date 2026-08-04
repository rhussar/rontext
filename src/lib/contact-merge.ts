import type { Contact, NewContact, NewContactChange } from "@/db/schema";

export function normalizeLinkedin(url: string | undefined): string | null {
  const v = (url ?? "").trim();
  if (!v) return null;
  return v.replace(/\/+$/, "").toLowerCase();
}

export function differs(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? []) !== JSON.stringify(b ?? []);
  }
  return (a ?? null) !== (b ?? null);
}

function serialize(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.join("; ");
  return String(v);
}

/**
 * Turn a computed contact patch into contact_changes rows, restricted to
 * trackedFields so bookkeeping columns never clutter the change feed.
 */
export function changeRowsFromPatch(
  existing: Contact,
  patch: Partial<NewContact>,
  source: "linkedin" | "import" | "manual",
  trackedFields: readonly (keyof NewContact)[],
): NewContactChange[] {
  const rows: NewContactChange[] = [];
  for (const field of trackedFields) {
    if (!(field in patch)) continue;
    const oldValue = serialize(existing[field as keyof Contact]);
    const newValue = serialize(patch[field]);
    if (oldValue === newValue) continue;
    rows.push({ contactId: existing.id, field, oldValue, newValue, source });
  }
  return rows;
}
