import Papa from "papaparse";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contactChanges, contacts, notes } from "@/db/schema";
import {
  isGoogleContactsCsv,
  parseGoogleCsvRow,
  parseVcards,
  type ParsedPerson,
} from "@/lib/vcard";
import { normalizeName } from "@/lib/duplicates";
import { imageFromBase64, type ImageIntake } from "@/lib/image-import";
import { storeContactPhoto } from "@/lib/photos";

export type ContactsImportSummary = {
  ok: boolean;
  error?: string;
  format?: "vcard" | "google-csv";
  parsed: number;
  matched: number;
  created: number;
  birthdaysAdded: number;
  emailsAdded: number;
  phonesAdded: number;
  fieldsFilled: number;
  photosAdded: number;
  unmatched: number;
};

const EMPTY: ContactsImportSummary = {
  ok: false,
  parsed: 0,
  matched: 0,
  created: 0,
  birthdaysAdded: 0,
  emailsAdded: 0,
  phonesAdded: 0,
  fieldsFilled: 0,
  photosAdded: 0,
  unmatched: 0,
};

const digits = (s: string) => s.replace(/\D/g, "");
const emailKey = (s: string) => s.trim().toLowerCase();

/**
 * Kept well below the app-wide 2 MB ceiling: a typical Contacts photo is
 * 20-80KB, so 500KB is generous headroom while still bounding row size on an
 * import that can touch every contact at once. The raster-only allowlist that
 * keeps script-carrying SVG off our own origin lives in image-import.ts.
 */
const VCARD_PHOTO_MAX_BYTES = 512_000;
const VCARD_PHOTO_LIMIT_LABEL = "500 KB";

/** vCard PHOTO bytes → a validated intake, or a rejection we quietly skip. */
function photoIntake(photo: ParsedPerson["photo"]): ImageIntake {
  if (!photo) return { ok: false, error: "No photo." };
  return imageFromBase64(
    photo.data,
    photo.contentType,
    VCARD_PHOTO_MAX_BYTES,
    VCARD_PHOTO_LIMIT_LABEL,
  );
}

function unionList(existing: string[], incoming: string[]): {
  merged: string[];
  added: number;
} {
  const seen = new Set(existing.map((v) => v.trim().toLowerCase()));
  const merged = [...existing];
  let added = 0;
  for (const v of incoming) {
    const k = v.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    merged.push(v.trim());
    added++;
  }
  return { merged, added };
}

export function parseContactsFile(
  text: string,
  filename: string,
): { people: ParsedPerson[]; format: "vcard" | "google-csv" } | { error: string } {
  const isVcf =
    /\.vcf$/i.test(filename) || /BEGIN:VCARD/i.test(text.slice(0, 2000));

  if (isVcf) {
    const people = parseVcards(text);
    if (!people.length)
      return { error: "No contacts found in that vCard file." };
    return { people, format: "vcard" };
  }

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const headers = Object.keys(parsed.data[0] ?? {});
  if (!isGoogleContactsCsv(headers)) {
    return {
      error:
        "That CSV doesn't look like a Google Contacts export. Export from contacts.google.com with the 'Google CSV' option, or upload a .vcf file.",
    };
  }
  const people = parsed.data
    .map(parseGoogleCsvRow)
    .filter((p) => p.fullName || p.emails.length || p.phoneNumbers.length);
  if (!people.length) return { error: "No usable rows in that CSV." };
  return { people, format: "google-csv" };
}

/**
 * Fold an address-book export into the existing contacts. This only ever fills
 * gaps — it never overwrites a value already on record, since LinkedIn/Mesh data
 * is generally fresher than a phone's address book for job fields.
 */
export async function importContactsFile(
  text: string,
  filename: string,
  opts: { createMissing: boolean },
): Promise<ContactsImportSummary> {
  const parsedResult = parseContactsFile(text, filename);
  if ("error" in parsedResult) return { ...EMPTY, error: parsedResult.error };
  const { people, format } = parsedResult;

  const db = getDb();
  const existing = await db.select().from(contacts);

  const byEmail = new Map<string, (typeof existing)[number]>();
  const byPhone = new Map<string, (typeof existing)[number]>();
  const byName = new Map<string, (typeof existing)[number] | "dup">();
  for (const c of existing) {
    for (const e of c.emails) if (e) byEmail.set(emailKey(e), c);
    for (const p of c.phoneNumbers) {
      const d = digits(p);
      if (d.length >= 10) byPhone.set(d.slice(-10), c);
    }
    const n = normalizeName(c.fullName);
    if (n) byName.set(n, byName.has(n) ? "dup" : c);
  }

  const summary: ContactsImportSummary = { ...EMPTY, ok: true, format };
  summary.parsed = people.length;

  for (const person of people) {
    let match: (typeof existing)[number] | undefined;
    for (const e of person.emails) {
      match = byEmail.get(emailKey(e));
      if (match) break;
    }
    if (!match) {
      for (const p of person.phoneNumbers) {
        const d = digits(p);
        if (d.length >= 10) match = byPhone.get(d.slice(-10));
        if (match) break;
      }
    }
    if (!match) {
      const hit = byName.get(normalizeName(person.fullName));
      if (hit && hit !== "dup") match = hit;
    }

    if (!match) {
      summary.unmatched++;
      if (opts.createMissing && person.fullName) {
        const [row] = await db
          .insert(contacts)
          .values({
            fullName: person.fullName,
            firstName: person.firstName,
            lastName: person.lastName,
            emails: person.emails,
            phoneNumbers: person.phoneNumbers,
            company: person.company,
            title: person.title,
            birthday: person.birthday,
            location: person.location,
            source: "import",
            interactionSources: ["address-book"],
          })
          .returning({ id: contacts.id });
        if (person.note?.trim()) {
          await db
            .insert(notes)
            .values({ contactId: row.id, body: person.note.trim(), source: "imported" });
        }
        const stored = await storeContactPhoto(row.id, photoIntake(person.photo), "vcard");
        if (stored.ok && stored.stored) summary.photosAdded++;
        summary.created++;
        if (person.birthday) summary.birthdaysAdded++;
      }
      continue;
    }

    summary.matched++;
    const patch: Record<string, unknown> = {};
    const changes: (typeof contactChanges.$inferInsert)[] = [];

    if (!match.birthday && person.birthday) {
      patch.birthday = person.birthday;
      summary.birthdaysAdded++;
    }
    if (!match.company && person.company) {
      patch.company = person.company;
      changes.push({
        contactId: match.id,
        field: "company",
        oldValue: null,
        newValue: person.company,
        source: "import",
      });
    }
    if (!match.title && person.title) patch.title = person.title;
    if (!match.location && person.location) patch.location = person.location;
    if (!match.linkedinUrl && person.linkedinUrl) {
      patch.linkedinUrl = person.linkedinUrl;
    }

    const em = unionList(match.emails, person.emails);
    if (em.added) {
      patch.emails = em.merged;
      summary.emailsAdded += em.added;
    }
    const ph = unionList(match.phoneNumbers, person.phoneNumbers);
    if (ph.added) {
      patch.phoneNumbers = ph.merged;
      summary.phonesAdded += ph.added;
    }
    if (!match.interactionSources.includes("address-book")) {
      patch.interactionSources = [...match.interactionSources, "address-book"];
    }

    // Own table, so this fills in alongside the field patch below rather than
    // competing with it — and only when nothing's on file yet, same "fill
    // gaps, never overwrite" rule as everything else in this pass. The
    // fillGapsOnly insert enforces that in one statement, no bookkeeping Set.
    const stored = await storeContactPhoto(match.id, photoIntake(person.photo), "vcard", {
      fillGapsOnly: true,
    });
    if (stored.ok && stored.stored) summary.photosAdded++;

    if (Object.keys(patch).length) {
      summary.fieldsFilled += Object.keys(patch).length;
      await db
        .update(contacts)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(contacts.id, match.id));
      if (changes.length) await db.insert(contactChanges).values(changes);
    }
  }

  return summary;
}
