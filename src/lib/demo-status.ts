import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appState } from "@/db/schema";
import { DEMO_SEED_KEY } from "@/lib/demo";

/**
 * True when the connected database carries the seed marker. The (app) layout
 * gates the whole shell on this in demo mode — see the note in lib/demo.ts.
 * Separate from demo.ts so that file stays free of DB imports.
 */
export async function demoSeededAt(): Promise<string | null> {
  const [row] = await getDb()
    .select({ value: appState.value })
    .from(appState)
    .where(eq(appState.key, DEMO_SEED_KEY));
  return row?.value ?? null;
}
