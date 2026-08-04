import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactChanges,
  contactPhotos,
  contacts,
  scrapeRuns,
  type NewContact,
  type NewContactChange,
} from "@/db/schema";
import { changeRowsFromPatch, differs, normalizeLinkedin } from "@/lib/contact-merge";

export type ScrapedProfile = {
  /** Required. Any casing / trailing slash — normalized on ingest. */
  linkedinUrl: string;
  fullName?: string;
  /** Free-text headline under the name — distinct from title. */
  headline?: string;
  /** Current role from the top Experience entry. */
  title?: string;
  company?: string;
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
  changes: { contact: string; field: string; old: string | null; new: string | null }[];
};

/** Fields the scraper owns on merge. fullName is insert-only — user renames win. */
const SCRAPE_KEYS: (keyof NewContact)[] = [
  "headline",
  "title",
  "company",
  "location",
  "linkedinUrl",
];

async function fetchPhoto(
  url: string,
): Promise<{ data: string; contentType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 2_000_000) return null;
    return { data: buf.toString("base64"), contentType };
  } catch {
    return null;
  }
}

export async function ingestLinkedinProfiles(
  profiles: ScrapedProfile[],
): Promise<ScrapeSummary> {
  const summary: ScrapeSummary = {
    ok: false,
    profileCount: profiles.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    changesLogged: 0,
    photosSaved: 0,
    photosFailed: [],
    changes: [],
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

    if (p.photoUrl) {
      const photo = await fetchPhoto(p.photoUrl);
      if (photo) {
        await db
          .insert(contactPhotos)
          .values({ contactId, ...photo, updatedAt: now })
          .onConflictDoUpdate({
            target: contactPhotos.contactId,
            set: { data: photo.data, contentType: photo.contentType, updatedAt: now },
          });
        summary.photosSaved++;
      } else {
        summary.photosFailed.push(p.linkedinUrl);
      }
    }
  }

  await db.insert(scrapeRuns).values({
    profileCount: byUrl.size,
    createdCount: summary.created,
    updatedCount: summary.updated,
    unchangedCount: summary.unchanged,
    changeCount: summary.changesLogged,
  });

  summary.ok = true;
  return summary;
}
