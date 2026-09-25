"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { followUps } from "@/db/schema";

/**
 * The owner's side of follow-ups: Home's check, snooze and "not a follow-up".
 * Agents write through src/lib/follow-ups.ts via MCP; nothing here can create
 * one. Done and dismissed are sticky: a later scan of the thread won't reopen
 * them.
 */

function revalidateAll() {
  revalidatePath("/", "layout");
}

async function close(id: number, status: "done" | "dismissed") {
  const now = new Date();
  await getDb()
    .update(followUps)
    .set({ status, closedAt: now, snoozedUntil: null, updatedAt: now })
    .where(eq(followUps.id, id));
  revalidateAll();
}

export async function completeFollowUp(id: number) {
  await close(id, "done");
}

export async function dismissFollowUp(id: number) {
  await close(id, "dismissed");
}

/** Undo for done/dismiss, and the end of a snooze. */
export async function reopenFollowUp(id: number) {
  await getDb()
    .update(followUps)
    .set({ status: "open", closedAt: null, snoozedUntil: null, updatedAt: new Date() })
    .where(eq(followUps.id, id));
  revalidateAll();
}

/** `until` arrives as an ISO instant; the client resolves "tomorrow morning" in the owner's timezone. */
export async function snoozeFollowUp(id: number, until: string) {
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) throw new Error("Invalid snooze time");
  await getDb()
    .update(followUps)
    .set({ snoozedUntil: at, updatedAt: new Date() })
    .where(eq(followUps.id, id));
  revalidateAll();
}
