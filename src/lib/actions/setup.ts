"use server";

import { SETUP_KEYS, type SetupStatus } from "@/lib/setup";
import { secretSources } from "@/lib/secrets";

/**
 * Which configured keys are present, and where each effective value comes
 * from ("app" = saved via Settings → Setup, "env" = environment variable).
 *
 * Returns presence and provenance and nothing else. The values are secrets,
 * and this result crosses to a client component — never widen this to include
 * them, not even masked or truncated, and never log them. `source` is
 * metadata about a secret, not the secret.
 */
export async function getSetupStatus(): Promise<SetupStatus[]> {
  const sources = await secretSources(SETUP_KEYS.map((k) => k.name));
  return SETUP_KEYS.map((k) => ({
    name: k.name,
    present: sources[k.name] !== null,
    source: sources[k.name],
  }));
}
