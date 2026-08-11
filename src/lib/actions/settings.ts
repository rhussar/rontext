"use server";

import { inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { appState } from "@/db/schema";
import {
  parseSettings,
  SETTINGS_KEYS,
  type Settings,
} from "@/lib/settings";

export async function getSettings(): Promise<Settings> {
  const rows = await getDb()
    .select()
    .from(appState)
    .where(inArray(appState.key, SETTINGS_KEYS as string[]));
  return parseSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const db = getDb();
  const entries = Object.entries(patch).filter(([k]) =>
    (SETTINGS_KEYS as string[]).includes(k),
  );
  if (entries.length) {
    await db
      .insert(appState)
      .values(
        entries.map(([key, value]) => ({
          key,
          value: String(value),
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: appState.key,
        // `excluded` refers to the row we tried to insert — needed because this
        // upserts several keys in one statement.
        set: { value: sql`excluded.value`, updatedAt: new Date() },
      });
  }
  revalidatePath("/", "layout");
  return getSettings();
}
