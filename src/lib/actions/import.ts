"use server";

import { revalidatePath } from "next/cache";
import { importCsvText, type ImportSummary } from "@/lib/import-core";

export type { ImportSummary };

export async function importCombinedCsv(
  formData: FormData,
): Promise<ImportSummary> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return {
      ok: false,
      error: "No file received.",
      rowCount: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      notesCreated: 0,
      groupsCreated: [],
    };
  }
  const text = await file.text();
  const summary = await importCsvText(text, file.name);
  if (summary.ok) revalidatePath("/", "layout");
  return summary;
}
