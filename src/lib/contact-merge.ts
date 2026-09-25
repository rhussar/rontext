import type { Contact, NewContact, NewContactChange } from "@/db/schema";

export function normalizeLinkedin(url: string | undefined): string | null {
  const v = (url ?? "").trim();
  if (!v) return null;
  return v.replace(/\/+$/, "").toLowerCase();
}

/**
 * "Is this the same LinkedIn profile?" — a comparison key, never a stored
 * value. Stored URLs arrive in whatever form their path wrote them (manual and
 * vCard entries aren't normalized at all), so equality on the raw string calls
 * `https://www.linkedin.com/in/Jane/` and `https://linkedin.com/in/jane` two
 * people. The `/in/<slug>` segment is the profile's identity; everything
 * around it (scheme, www, country subdomain, query, trailing path) is not.
 */
export function linkedinKey(url: string | null | undefined): string | null {
  const v = normalizeLinkedin(url ?? undefined);
  if (!v) return null;
  const slug = v.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
  if (slug) {
    try {
      return `in/${decodeURIComponent(slug)}`;
    } catch {
      return `in/${slug}`; // malformed escape — compare it as written
    }
  }
  return v
    .replace(/^https?:\/\//, "")
    .replace(/^([a-z]{2,3}|www)\.linkedin\.com/, "linkedin.com")
    .replace(/[?#].*$/, "");
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
  source: NewContactChange["source"],
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
