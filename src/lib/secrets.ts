/**
 * Read side of UI-editable keys.
 *
 * Integration keys can be set from Settings → Setup, stored write-only in
 * app_state under `secret:<NAME>`. This module resolves the *effective* value:
 * the DB row wins, the environment variable is the fallback. DB-wins is the
 * whole point — a value saved in the UI must take effect immediately, while a
 * Vercel env change needs a redeploy; env-wins would make the UI silently
 * inert whenever a stale var exists. The escape hatch from a bad DB value is
 * Clear (falls back to env), which the Setup panel exposes.
 *
 * Deliberately NOT a "use server" module: these functions return secret
 * values, so they must have no client-callable surface. Server code and CLI
 * scripts import them directly; the write side lives in
 * src/lib/actions/secrets.ts and never reads values back.
 *
 * Consequence worth knowing: once a DB row exists, editing the env var does
 * nothing until the row is cleared. The Setup panel shows "Set here" vs
 * "Set in env" so this is never a mystery.
 */
import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { appState } from "@/db/schema";

const PREFIX = "secret:";

export async function getSecret(name: string): Promise<string | null> {
  const values = await getSecrets(name);
  return values[name] ?? null;
}

/** One round trip for several keys — the X signer needs four at once. */
export async function getSecrets(
  ...names: string[]
): Promise<Record<string, string | null>> {
  const rows = await getDb()
    .select({ key: appState.key, value: appState.value })
    .from(appState)
    .where(inArray(appState.key, names.map((n) => PREFIX + n)));
  const byName = new Map(rows.map((r) => [r.key.slice(PREFIX.length), r.value.trim()]));

  const out: Record<string, string | null> = {};
  for (const name of names) {
    out[name] = byName.get(name) || process.env[name]?.trim() || null;
  }
  return out;
}

/**
 * Where a key's effective value comes from — powers the Setup panel's
 * "Set here" / "Set in env" pills. Provenance only, no values.
 */
export async function secretSources(
  names: string[],
): Promise<Record<string, "app" | "env" | null>> {
  const rows = await getDb()
    .select({ key: appState.key, value: appState.value })
    .from(appState)
    .where(inArray(appState.key, names.map((n) => PREFIX + n)));
  const inDb = new Set(
    rows.filter((r) => r.value.trim()).map((r) => r.key.slice(PREFIX.length)),
  );

  const out: Record<string, "app" | "env" | null> = {};
  for (const name of names) {
    out[name] = inDb.has(name) ? "app" : process.env[name]?.trim() ? "env" : null;
  }
  return out;
}

/** Storage key for the write side — kept here so the prefix has one owner. */
export function secretStorageKey(name: string): string {
  return PREFIX + name;
}

type CacheEntry = { value: string | null; expires: number };
const cache = new Map<string, CacheEntry>();

/**
 * TTL-cached read, for hot paths that can tolerate staleness — concretely the
 * MCP route, where auth runs on every request and an unauthenticated probe
 * shouldn't cost a Neon round trip. Per-instance only (serverless lambdas
 * don't share memory), so a token generated or cleared in the UI takes up to
 * `ttlMs` to be honored on a warm instance. 60s is below human retry latency
 * for wiring up an MCP client, and strictly better than "redeploy Vercel".
 */
export async function getSecretCached(
  name: string,
  ttlMs = 60_000,
): Promise<string | null> {
  const hit = cache.get(name);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await getSecret(name);
  cache.set(name, { value, expires: Date.now() + ttlMs });
  return value;
}
