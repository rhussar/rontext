"use server";

import { desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { imports } from "@/db/schema";
import { importCsvText, type ImportSummary } from "@/lib/import-core";

export type { ImportSummary };

export type ImportHistoryItem = {
  id: number;
  filename: string;
  createdCount: number;
  updatedCount: number;
  createdAt: string;
};

/**
 * Fetched on demand when the Accounts tab opens rather than in the app layout —
 * no reason to pay for this query on every page load.
 */
export async function getImportHistory(): Promise<ImportHistoryItem[]> {
  const rows = await getDb()
    .select({
      id: imports.id,
      filename: imports.filename,
      createdCount: imports.createdCount,
      updatedCount: imports.updatedCount,
      createdAt: imports.createdAt,
    })
    .from(imports)
    .orderBy(desc(imports.createdAt))
    .limit(10);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

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
