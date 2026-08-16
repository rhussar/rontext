import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactChanges,
  contactEducation,
  contacts,
  scrapeRuns,
  type NewContact,
  type NewContactChange,
} from "@/db/schema";
import { changeRowsFromPatch, differs, normalizeLinkedin } from "@/lib/contact-merge";
import { imageFromUrl } from "@/lib/image-import";
import { PHOTO_LIMIT_LABEL, PHOTO_MAX_BYTES, storeContactPhoto } from "@/lib/photos";

export type ScrapedProfile = {
  /** Required. Any casing / trailing slash — normalized on ingest. */
  linkedinUrl: string;
  fullName?: string;
  /** Free-text headline under the name — distinct from title. */
  headline?: string;
  /** Current role from the top Experience entry. */
  title?: string;
  company?: string;
  /**
   * Most recent school from the top card. Fill-gaps only: adds a
   * contact_education row when no row with that school exists — never
   * edits or removes hand-entered education (see the schema comment there).
   */
  school?: string;
  location?: string;
  /** "YYYY-MM-DD", only available from the connections list. */
  connectedOn?: string;
  /** LinkedIn CDN avatar URL — fetched now, bytes stored, URL discarded. */
  photoUrl?: string;
};

export type ScrapeSummary = {
  ok: boolean;
  error?: string;
  profileCount: number;
  created: number;
  updated: number;
  unchanged: number;
  changesLogged: number;
  photosSaved: number;
  photosFailed: string[];
  /** contact_education rows added (school seen on the top card, not yet listed). */
  schoolsAdded: number;
  /** Profiles for URLs not in the CRM when createMissing is off. */
  skipped: number;
  changes: { contact: string; field: string; old: string | null; new: string | null }[];
  /** Contact ids touched (created or matched), in batch order — the extension uses it. */
  contactIds: number[];
};

/** Fields the scraper owns on merge. fullName is insert-only — user renames win. */
const SCRAPE_KEYS: (keyof NewContact)[] = [
  "headline",
  "title",
  "company",
  "location",
  "linkedinUrl",
];

export async function ingestLinkedinProfiles(
  profiles: ScrapedProfile[],
  opts: {
    /**
     * Insert a contact for a URL we don't have (default true — a Claude batch
     * is a curated list). The Chrome extension passes false: it sees every
     * profile the owner happens to browse, and a connector must never
     * auto-create. Unknown URLs are counted in `skipped` instead.
     */
    createMissing?: boolean;
    /** Write the scrape_runs row (default true). The extension folds runs itself. */
    recordRun?: boolean;
  } = {},
): Promise<ScrapeSummary> {
  const createMissing = opts.createMissing ?? true;
  const summary: ScrapeSummary = {
    ok: false,
    profileCount: profiles.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    changesLogged: 0,
    photosSaved: 0,
    photosFailed: [],
    schoolsAdded: 0,
    skipped: 0,
    changes: [],
    contactIds: [],
  };

  // Validate + dedupe within the batch by normalized URL
  const byUrl = new Map<string, ScrapedProfile>();
  for (const p of profiles) {
    const url = normalizeLinkedin(p.linkedinUrl);
    if (!url || !url.includes("linkedin.com/")) {
      summary.error = `Profile missing/invalid linkedinUrl: ${JSON.stringify(p).slice(0, 120)}`;
      return summary;
    }
    byUrl.set(url, { ...p, linkedinUrl: url });
  }

  const db = getDb();
  const existing = await db.select().from(contacts);
  const byLinkedin = new Map<string, (typeof existing)[number]>();
  const byName = new Map<string, (typeof existing)[number] | "dup">();
  for (const c of existing) {
    if (c.linkedinUrl) byLinkedin.set(c.linkedinUrl, c);
    const key = c.fullName.trim().toLowerCase();
    byName.set(key, byName.has(key) ? "dup" : c);
  }

  const now = new Date();

  for (const p of byUrl.values()) {
    let match = byLinkedin.get(p.linkedinUrl) ?? undefined;
    if (!match && p.fullName) {
      const nameHit = byName.get(p.fullName.trim().toLowerCase());
      if (nameHit && nameHit !== "dup") match = nameHit;
    }

    let contactId: number;
    if (!match && !createMissing) {
      summary.skipped++;
      continue;
    }
    if (!match) {
      const fullName = (p.fullName ?? "").trim() || "Unnamed person";
      const spaceAt = fullName.indexOf(" ");
      const [row] = await db
        .insert(contacts)
        .values({
          fullName,
          firstName: spaceAt > 0 ? fullName.slice(0, spaceAt) : fullName,
          lastName: spaceAt > 0 ? fullName.slice(spaceAt + 1) : null,
          headline: p.headline?.trim() || null,
          title: p.title?.trim() || null,
          company: p.company?.trim() || null,
          location: p.location?.trim() || null,
          linkedinUrl: p.linkedinUrl,
          linkedinConnectedOn: p.connectedOn || null,
          source: "linkedin",
          lastScrapedAt: now,
        })
        .returning({ id: contacts.id });
      contactId = row.id;
      await db.insert(contactChanges).values({
        contactId,
        field: "connected",
        oldValue: null,
        newValue: fullName,
        source: "linkedin",
      });
      summary.created++;
      summary.changesLogged++;
      summary.changes.push({ contact: fullName, field: "connected", old: null, new: fullName });
    } else {
      // Non-blanking merge over scrape-owned fields only
      const patch: Partial<NewContact> = {};
      const incoming: Partial<NewContact> = {
        headline: p.headline?.trim() || null,
        title: p.title?.trim() || null,
        company: p.company?.trim() || null,
        location: p.location?.trim() || null,
        linkedinUrl: p.linkedinUrl,
      };
      for (const key of SCRAPE_KEYS) {
        const value = incoming[key];
        if (value == null) continue;
        if (differs(value, match[key as keyof typeof match])) {
          (patch as Record<string, unknown>)[key] = value;
        }
      }
      if (p.connectedOn && !match.linkedinConnectedOn) {
        patch.linkedinConnectedOn = p.connectedOn;
      }

      const changeRows: NewContactChange[] = changeRowsFromPatch(
        match,
        patch,
        "linkedin",
        SCRAPE_KEYS,
      );
      // Update first, change rows second: a crash can never leave phantom history
      await db
        .update(contacts)
        .set({ ...patch, lastScrapedAt: now, updatedAt: now })
        .where(eq(contacts.id, match.id));
      if (changeRows.length) {
        // Only ever keep the latest headline change — previous role → new role,
        // never a running history. Delete before insert so the surviving row's
        // oldValue is always the headline this one replaced.
        if (changeRows.some((r) => r.field === "headline")) {
          await db
            .delete(contactChanges)
            .where(
              and(
                eq(contactChanges.contactId, match.id),
                eq(contactChanges.field, "headline"),
              ),
            );
        }
        await db.insert(contactChanges).values(changeRows);
        summary.updated++;
        summary.changesLogged += changeRows.length;
        for (const r of changeRows) {
          summary.changes.push({
            contact: match.fullName,
            field: r.field,
            old: r.oldValue ?? null,
            new: r.newValue ?? null,
          });
        }
      } else {
        summary.unchanged++;
      }
      contactId = match.id;
    }

    summary.contactIds.push(contactId);

    if (p.school?.trim()) {
      const school = p.school.trim();
      const key = school.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const rows = await db
        .select({ school: contactEducation.school })
        .from(contactEducation)
        .where(eq(contactEducation.contactId, contactId));
      const known = rows.some(
        (r) => r.school.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === key,
      );
      if (!known) {
        await db.insert(contactEducation).values({ contactId, school });
        summary.schoolsAdded++;
      }
    }

    if (p.photoUrl) {
      const intake = await imageFromUrl(p.photoUrl, PHOTO_MAX_BYTES, PHOTO_LIMIT_LABEL);
      const saved = await storeContactPhoto(contactId, intake, "linkedin");
      if (saved.ok) {
        summary.photosSaved++;
      } else {
        summary.photosFailed.push(p.linkedinUrl);
      }
    }
  }

  if (opts.recordRun ?? true) {
    await db.insert(scrapeRuns).values({
      source: "claude",
      profileCount: byUrl.size,
      createdCount: summary.created,
      updatedCount: summary.updated,
      unchangedCount: summary.unchanged,
      changeCount: summary.changesLogged,
    });
  }

  summary.ok = true;
  return summary;
}
