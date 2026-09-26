/**
 * Filling in LinkedIn URLs from an agent — the MCP `set_linkedin_urls` tool.
 *
 * An agent that finds someone's profile (a roster it just imported, a web
 * search, a meeting attendee) had no way to record it: add_contacts never
 * touches an existing contact's fields, and scripts/apply-linkedin-urls.ts
 * needs the database credential on the owner's Mac. The URL is what the
 * LinkedIn extension and sync key on, so a profile left in a note is one they
 * never enrich.
 *
 * Same guardrails as the script, stated as statuses the agent can act on:
 *
 *  - Blanks only. A contact that already has a LinkedIn URL keeps it; a
 *    different one comes back `has_other_url` with the current value, for the
 *    owner to settle in the app.
 *  - One profile, one person. A URL whose /in/<slug> is already on another
 *    contact (in any spelling, archived included — lookupContacts' key) comes
 *    back `taken`, never moved: two contacts sharing a profile means a
 *    duplicate or a wrong match, and either is the owner's call.
 *  - Archived contacts are left alone, as add_contacts leaves them.
 *  - Not an interaction: no dates move, only the URL and a change row.
 *
 * Stored as https://www.linkedin.com/in/<slug>, so a country subdomain or a
 * tracking query from a search result doesn't land in the column.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contactChanges, contacts } from "@/db/schema";
import { lookupContacts } from "@/lib/contact-lookup";
import { linkedinKey } from "@/lib/contact-merge";

export const SET_LINKEDIN_MAX = 100;

export type SetLinkedinStatus =
  | "set"
  | "already_set"
  | "has_other_url"
  | "taken"
  | "archived"
  | "not_found"
  | "invalid"
  | "duplicate_in_batch";

export type SetLinkedinRow = {
  row: number;
  contactId: number;
  name?: string;
  status: SetLinkedinStatus;
  /** What was (or, on a dry run, would be) stored. */
  linkedinUrl?: string;
  /** The URL already on the contact, for has_other_url. */
  currentUrl?: string;
  /** Contacts that already hold this profile, for taken. */
  heldBy?: { id: number; fullName: string }[];
  reason?: string;
};

export type SetLinkedinResult = {
  ok: boolean;
  dryRun: boolean;
  set: number;
  notTouched: number;
  results: SetLinkedinRow[];
  error?: string;
};

/** The /in/<slug> of a LinkedIn profile URL, or null for anything else. */
function profileSlug(raw: string): string | null {
  if (!/linkedin\.com\/in\//i.test(raw)) return null;
  const key = linkedinKey(raw);
  return key?.startsWith("in/") && key.length > 3 ? key.slice(3) : null;
}

export async function setLinkedinUrls(opts: {
  items: { contactId: number; linkedinUrl: string }[];
  dryRun?: boolean;
}): Promise<SetLinkedinResult> {
  const dryRun = opts.dryRun ?? false;
  const out: SetLinkedinResult = { ok: false, dryRun, set: 0, notTouched: 0, results: [] };
  if (opts.items.length > SET_LINKEDIN_MAX) {
    out.error = `At most ${SET_LINKEDIN_MAX} per call — split the batch`;
    return out;
  }
  const db = getDb();

  const ids = [...new Set(opts.items.map((i) => i.contactId))];
  const rows = ids.length
    ? await db
        .select({
          id: contacts.id,
          fullName: contacts.fullName,
          linkedinUrl: contacts.linkedinUrl,
          archivedAt: contacts.archivedAt,
        })
        .from(contacts)
        .where(inArray(contacts.id, ids))
    : [];
  const byId = new Map(rows.map((c) => [c.id, c]));

  const holders = await lookupContacts({ linkedinUrls: opts.items.map((i) => i.linkedinUrl) });
  const holdersByInput = new Map(holders.map((h) => [h.input, h.matches]));

  const skip = (r: SetLinkedinRow) => {
    out.results.push(r);
    out.notTouched++;
  };
  const planned: { row: number; id: number; name: string; url: string }[] = [];
  const seenIds = new Map<number, number>();
  const seenSlugs = new Map<string, number>();

  opts.items.forEach((item, i) => {
    const row = i + 1;
    const c = byId.get(item.contactId);
    const base = { row, contactId: item.contactId, ...(c ? { name: c.fullName } : {}) };
    const slug = profileSlug(item.linkedinUrl);
    if (!slug) {
      return skip({ ...base, status: "invalid", reason: "Not a linkedin.com/in/<profile> URL" });
    }
    // linkedinKey decodes the slug; re-encode so a non-ASCII one stays a valid URL.
    const url = `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;

    // Checked before the book so a repeated row reports as the repeat it is.
    const dupRow = seenIds.get(item.contactId) ?? seenSlugs.get(slug);
    if (dupRow !== undefined) {
      return skip({ ...base, status: "duplicate_in_batch", linkedinUrl: url, reason: `Same contact or profile as row ${dupRow}` });
    }
    seenIds.set(item.contactId, row);
    seenSlugs.set(slug, row);

    if (!c) return skip({ ...base, status: "not_found", reason: `No contact with id ${item.contactId}` });
    if (c.archivedAt) {
      return skip({ ...base, status: "archived", reason: "Archived — the owner decides whether to restore" });
    }
    if (c.linkedinUrl) {
      return linkedinKey(c.linkedinUrl) === `in/${slug}`
        ? skip({ ...base, status: "already_set", linkedinUrl: c.linkedinUrl })
        : skip({
            ...base,
            status: "has_other_url",
            currentUrl: c.linkedinUrl,
            reason: "Already has a different LinkedIn URL; it is never replaced here",
          });
    }
    const others = (holdersByInput.get(item.linkedinUrl) ?? []).filter((m) => m.id !== c.id);
    if (others.length) {
      return skip({
        ...base,
        status: "taken",
        linkedinUrl: url,
        heldBy: others.map((m) => ({ id: m.id, fullName: m.fullName })),
        reason: "This profile is already on another contact — a duplicate or a wrong match; the owner decides",
      });
    }
    planned.push({ row, id: c.id, name: c.fullName, url });
  });

  for (const p of planned) {
    if (!dryRun) {
      // `linkedin_url is null` in the WHERE keeps "blanks only" true even if
      // something else filled it since the read above.
      let wrote: { id: number }[];
      try {
        wrote = await db
          .update(contacts)
          .set({ linkedinUrl: p.url, updatedAt: new Date() })
          .where(and(eq(contacts.id, p.id), isNull(contacts.linkedinUrl)))
          .returning({ id: contacts.id });
      } catch {
        // contacts_linkedin_url_uq: another contact took this exact URL since
        // the lookup above.
        skip({ row: p.row, contactId: p.id, name: p.name, status: "taken", linkedinUrl: p.url, reason: "Taken by another contact during this call" });
        continue;
      }
      if (!wrote.length) {
        skip({ row: p.row, contactId: p.id, name: p.name, status: "has_other_url", reason: "Filled by something else during this call" });
        continue;
      }
      await db.insert(contactChanges).values({
        contactId: p.id,
        field: "linkedinUrl",
        oldValue: null,
        newValue: p.url,
        source: "import",
      });
    }
    out.results.push({ row: p.row, contactId: p.id, name: p.name, status: "set", linkedinUrl: p.url });
    out.set++;
  }

  if (!dryRun && out.set) {
    // Visible without a reload; same as every other contact write.
    try {
      revalidatePath("/", "layout");
    } catch {
      // Outside a request (scripts, tests) there is nothing to revalidate.
    }
  }

  out.results.sort((a, b) => a.row - b.row);
  out.ok = true;
  return out;
}
