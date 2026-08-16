/**
 * POST /api/ext/linkedin/photo — avatar bytes for a contact the profile
 * endpoint just reported as needsPhoto. Separate from /profile so the
 * extension only ships image bytes for people who lack one, and so a photo
 * retry doesn't re-run (and re-count) the profile merge. Fill-gaps only via
 * the single photo writer; raster-only, size-capped, same as every path.
 */
import { z } from "zod";
import { extAuthorized, extJson, extOptions, extUnauthorized } from "@/lib/ext-auth";
import { imageFromBase64 } from "@/lib/image-import";
import { PHOTO_LIMIT_LABEL, PHOTO_MAX_BYTES, storeContactPhoto } from "@/lib/photos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  contactId: z.number().int().positive(),
  photo: z.object({ data: z.string().max(3_000_000), contentType: z.string().max(60) }),
});

export function OPTIONS() {
  return extOptions();
}

export async function POST(req: Request) {
  if (!(await extAuthorized(req))) return extUnauthorized();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return extJson({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return extJson({ error: "invalid body" }, { status: 400 });
  const { contactId, photo } = parsed.data;
  const intake = imageFromBase64(photo.data, photo.contentType, PHOTO_MAX_BYTES, PHOTO_LIMIT_LABEL);
  const saved = await storeContactPhoto(contactId, intake, "linkedin", { fillGapsOnly: true });
  if (!saved.ok) return extJson({ ok: false, error: saved.error }, { status: 400 });
  return extJson({ ok: true, stored: saved.stored });
}
