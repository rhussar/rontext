"use server";

import { revalidatePath } from "next/cache";
import { importContactsFile } from "@/lib/contacts-import-core";
import { importCsvText } from "@/lib/import-core";

export type AnyImportResult = {
  ok: boolean;
  error?: string;
  /** One-line summary to show under the button. */
  message?: string;
};

/**
 * One entry point for every supported file. The shape of the file decides which
 * importer runs, so there's nothing for the user to pick.
 */
export async function importAnyFile(
  formData: FormData,
): Promise<AnyImportResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "No file received." };

  const text = await file.text();
  const name = file.name;
  const head = text.slice(0, 4000);

  const isVcard = /\.vcf$/i.test(name) || /BEGIN:VCARD/i.test(head);
  // The merged Mesh export is the only CSV carrying these columns.
  const isMeshCsv =
    !isVcard && /(^|,)\s*"?full_name"?\s*(,|$)/im.test(head.split("\n")[0] ?? "");

  if (isMeshCsv) {
    const s = await importCsvText(text, name);
    if (!s.ok) return { ok: false, error: s.error };
    revalidatePath("/", "layout");
    const bits = [`${s.created} added`, `${s.updated} updated`];
    if (s.notesCreated) bits.push(`${s.notesCreated} notes`);
    return { ok: true, message: `${name} — ${bits.join(", ")}.` };
  }

  // vCard or Google CSV. createMissing stays on: a phone export is a list of
  // people you know, so silently dropping the unmatched ones would be surprising.
  const s = await importContactsFile(text, name, { createMissing: true });
  if (!s.ok) return { ok: false, error: s.error };
  revalidatePath("/", "layout");

  const bits: string[] = [];
  if (s.created) bits.push(`${s.created} added`);
  if (s.matched) bits.push(`${s.matched} matched`);
  if (s.birthdaysAdded) bits.push(`🎂 ${s.birthdaysAdded} birthdays`);
  if (s.emailsAdded + s.phonesAdded)
    bits.push(`${s.emailsAdded + s.phonesAdded} emails/phones`);
  if (s.photosAdded) bits.push(`${s.photosAdded} photos`);
  return {
    ok: true,
    message: bits.length
      ? `${name} — ${bits.join(", ")}.`
      : `${name} — nothing new to add.`,
  };
}
