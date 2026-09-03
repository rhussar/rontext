/**
 * Demo mode — the public, read-only showcase deployment.
 *
 * Set `DEMO_MODE=1` on a deployment whose DATABASE_URL points at a database
 * holding *generated* people (scripts/seed-demo.ts). Three things then change:
 *
 *   1. src/db/index.ts hands out a Drizzle instance whose write entry points
 *      throw DemoReadOnlyError, so no server action or route can mutate.
 *   2. src/proxy.ts signs every visitor in automatically — there is nothing
 *      to protect, and a passcode prompt would be the whole first impression.
 *   3. The shell hides mutation controls and shows a banner (ShellContext.demo).
 *
 * Privacy does NOT come from any of this; it comes from the demo database
 * never containing real data. The (app) layout refuses to render a database
 * that lacks the DEMO_SEED_KEY marker, so a mis-pointed DATABASE_URL shows a
 * "not seeded" page rather than someone's contacts.
 *
 * No runtime imports here on purpose: client components import the error
 * class and the links, and must never drag `node:` modules along.
 */

export function isDemo(): boolean {
  return process.env.DEMO_MODE === "1";
}

/** app_state key the seed writes last; its presence is what makes a DB "the demo". */
export const DEMO_SEED_KEY = "demo:seed";

/** The only database name the seed script will truncate. */
export const DEMO_DB_NAME = "rontext_demo";

export const DEMO_LINKS = {
  github: "https://github.com/rhussar/rontext",
} as const;

export class DemoReadOnlyError extends Error {
  constructor() {
    super("This demo is read-only");
    this.name = "DemoReadOnlyError";
  }
}

/**
 * `instanceof` alone misses errors that crossed a module boundary twice (two
 * copies of the class under tsx + Next's bundling), so match on the name too.
 */
export function isDemoReadOnlyError(e: unknown): boolean {
  return (
    e instanceof DemoReadOnlyError ||
    (e instanceof Error && e.name === "DemoReadOnlyError")
  );
}

/**
 * Run a write that is merely a cache/bookkeeping side effect of a read (the
 * activity read-marker seed, the geocode cache stamp). In demo mode those
 * writes fail; the read they decorate should not.
 */
export async function ignoringDemoReadOnly<T>(
  fn: () => PromiseLike<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (isDemoReadOnlyError(e)) return undefined;
    throw e;
  }
}
