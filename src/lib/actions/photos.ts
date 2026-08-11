"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contactPhotos } from "@/db/schema";
import { imageFromFile, imageFromUrl, type ImageIntake } from "@/lib/image-import";
import {
  PHOTO_LIMIT_LABEL,
  PHOTO_MAX_BYTES,
  storeContactPhoto,
  type PhotoResult,
} from "@/lib/photos";

const MAX_BYTES = PHOTO_MAX_BYTES;
const LIMIT_LABEL = PHOTO_LIMIT_LABEL;

export type { PhotoResult };

/**
 * Photos are stored the same way backfilled and scraped ones are — base64 in
 * contact_photos, one row per contact — so a manual upload and a synced
 * avatar are indistinguishable downstream apart from `source`.
 */
async function store(contactId: number, intake: ImageIntake): Promise<PhotoResult> {
  const result = await storeContactPhoto(contactId, intake, "manual");
  if (result.ok) revalidatePath("/", "layout");
  return result;
}

export async function uploadContactPhoto(
  contactId: number,
  formData: FormData,
): Promise<PhotoResult> {
  return store(
    contactId,
    await imageFromFile(formData.get("file"), MAX_BYTES, LIMIT_LABEL),
  );
}

export async function importContactPhotoFromUrl(
  contactId: number,
  url: string,
): Promise<PhotoResult> {
  return store(contactId, await imageFromUrl(url, MAX_BYTES, LIMIT_LABEL));
}

export async function removeContactPhoto(contactId: number): Promise<void> {
  const db = getDb();
  await db.delete(contactPhotos).where(eq(contactPhotos.contactId, contactId));
  revalidatePath("/", "layout");
}
