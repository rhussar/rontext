"use server";

/**
 * Write side of UI-editable keys. Values flow client → here → app_state and
 * never back: there is no read action in this module or anywhere client-
 * callable, which is what makes the Setup panel's "write-only" promise real.
 *
 * Two rules keep values out of logs and error payloads:
 *  - no console.* in this module, ever;
 *  - DB errors are caught and replaced with generic messages — a thrown Neon
 *    error can embed the parameterized query (i.e. the secret), and Next
 *    serializes thrown server-action errors to the client in dev.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { appState } from "@/db/schema";
import { SETUP_KEYS } from "@/lib/setup";
import { secretStorageKey } from "@/lib/secrets";
import { getSetupStatus } from "@/lib/actions/setup";
import type { SetupStatus } from "@/lib/setup";

export type SecretWriteResult =
  | { ok: true; setup: SetupStatus[] }
  | { ok: false; error: string };

const MAX_VALUE_LENGTH = 4096;

/** Editable = configured in SETUP_KEYS and not a bootstrap key. */
function editable(name: string): boolean {
  const key = SETUP_KEYS.find((k) => k.name === name);
  return !!key && key.scope !== "bootstrap";
}

async function upsert(name: string, value: string): Promise<void> {
  await getDb()
    .insert(appState)
    .values({ key: secretStorageKey(name), value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appState.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function setSecret(
  name: string,
  value: string,
): Promise<SecretWriteResult> {
  if (!editable(name)) return { ok: false, error: "That key can't be set here." };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: "Paste a value first." };
  if (trimmed.length > MAX_VALUE_LENGTH) {
    return { ok: false, error: "That doesn't look like a key (too long)." };
  }
  try {
    await upsert(name, trimmed);
  } catch {
    return { ok: false, error: "Couldn't save — try again." };
  }
  revalidatePath("/", "layout");
  return { ok: true, setup: await getSetupStatus() };
}

export async function clearSecret(name: string): Promise<SecretWriteResult> {
  if (!editable(name)) return { ok: false, error: "That key can't be cleared here." };
  try {
    await getDb().delete(appState).where(eq(appState.key, secretStorageKey(name)));
  } catch {
    return { ok: false, error: "Couldn't clear — try again." };
  }
  revalidatePath("/", "layout");
  return { ok: true, setup: await getSetupStatus() };
}

/**
 * Mint and store a fresh MCP bearer token, returning the plaintext exactly
 * once so the reveal block can offer it for copy (the GitHub-token pattern).
 * No action can read it back afterward. Not hashed on purpose: the route's
 * bearer compare, the env-fallback path, and the `claude mcp add` command all
 * need the plaintext, and the single user can read their own database anyway —
 * "shown once" is a UI contract against shoulder-surfing, not cryptography.
 *
 * The MCP route caches the token for up to 60s (see getSecretCached), so a
 * just-generated token may take that long to be honored on a warm instance.
 */
/** Keys the UI mints rather than pastes — random, shown once. */
const GENERATED_KEYS = new Set(["MCP_TOKEN", "EXTENSION_TOKEN"]);

export async function generateToken(
  name: string,
): Promise<{ ok: true; token: string; setup: SetupStatus[] } | { ok: false; error: string }> {
  if (!GENERATED_KEYS.has(name)) return { ok: false, error: "That key isn't generated here." };
  const token = randomBytes(32).toString("hex");
  try {
    await upsert(name, token);
  } catch {
    return { ok: false, error: "Couldn't save — try again." };
  }
  revalidatePath("/", "layout");
  return { ok: true, token, setup: await getSetupStatus() };
}

export async function generateMcpToken(): Promise<
  { ok: true; token: string; setup: SetupStatus[] } | { ok: false; error: string }
> {
  const token = randomBytes(32).toString("hex");
  try {
    await upsert("MCP_TOKEN", token);
  } catch {
    return { ok: false, error: "Couldn't save — try again." };
  }
  revalidatePath("/", "layout");
  return { ok: true, token, setup: await getSetupStatus() };
}
