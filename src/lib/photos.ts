/**
 * The one place contact_photos gets written.
 *
 * Three call sites used to hand-roll this with three different size caps and
 * three different mime allowlists — the loosest of them accepted SVG, which
 * /api/photos/[contactId] then served same-origin. Everything now funnels
 * through storeContactPhoto() with validation from image-import.ts, so a photo
 * is a photo regardless of whether it was uploaded, pasted, imported from a
 * vCard, scraped, or backfilled.
 *
 * Deliberately not a "use server" module: scripts/backfill-photos.ts needs it
 * from a plain tsx process, where revalidatePath() doesn't exist. Server
 * actions wrap it and revalidate themselves.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contactPhotos, contacts } from "@/db/schema";
import type { ImageIntake } from "@/lib/image-import";

/** A profile photo renders at 96px, so 2 MB is already generous. */
export const PHOTO_MAX_BYTES = 2_000_000;
export const PHOTO_LIMIT_LABEL = "2 MB";

export type PhotoSource = "manual" | "vcard" | "linkedin" | "unavatar";

export type PhotoResult =
  | { ok: true; stored: boolean }
  | { ok: false; error: string };

export async function storeContactPhoto(
  contactId: number,
  intake: ImageIntake,
  source: PhotoSource,
  opts: { fillGapsOnly?: boolean } = {},
): Promise<PhotoResult> {
  if (!intake.ok) return intake;

  const db = getDb();
  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.id, contactId));
  if (!contact) return { ok: false, error: "Unknown person." };

  const values = {
    contactId,
    data: intake.data,
    contentType: intake.contentType,
    source,
  };

  if (opts.fillGapsOnly) {
    // One atomic statement instead of "prefetch who already has one, then
    // insert" — no race, and no Set to keep in sync.
    const rows = await db
      .insert(contactPhotos)
      .values(values)
      .onConflictDoNothing()
      .returning({ contactId: contactPhotos.contactId });
    return { ok: true, stored: rows.length > 0 };
  }

  await db
    .insert(contactPhotos)
    .values(values)
    .onConflictDoUpdate({
      target: contactPhotos.contactId,
      set: {
        data: intake.data,
        contentType: intake.contentType,
        source,
        // Doubles as the ETag source in /api/photos/[contactId] — without the
        // bump a replaced photo keeps serving the old bytes from cache.
        updatedAt: new Date(),
      },
    });
  return { ok: true, stored: true };
}
