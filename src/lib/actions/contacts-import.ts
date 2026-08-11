"use server";

import { revalidatePath } from "next/cache";
import {
  importContactsFile,
  type ContactsImportSummary,
} from "@/lib/contacts-import-core";

export type { ContactsImportSummary };

export async function importAddressBook(
  formData: FormData,
): Promise<ContactsImportSummary> {
  const file = formData.get("file");
  const createMissing = formData.get("createMissing") === "on";
  if (!(file instanceof File)) {
    return {
      ok: false,
      error: "No file received.",
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
  }
  const text = await file.text();
  const summary = await importContactsFile(text, file.name, { createMissing });
  if (summary.ok) revalidatePath("/", "layout");
  return summary;
}
