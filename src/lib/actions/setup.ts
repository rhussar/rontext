"use server";

import { SETUP_KEYS, type SetupStatus } from "@/lib/setup";

/**
 * Which configured keys are present.
 *
 * Returns booleans and nothing else. The values are secrets, and this result
 * crosses to a client component — never widen this to include them, not even
 * masked or truncated, and never log them.
 */
export async function getSetupStatus(): Promise<SetupStatus[]> {
  return SETUP_KEYS.map((k) => ({
    name: k.name,
    present: Boolean(process.env[k.name]?.trim()),
  }));
}
