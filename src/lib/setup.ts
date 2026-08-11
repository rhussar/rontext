/**
 * What a fresh install of this app needs — the checklist behind Settings → Setup.
 *
 * The panel exists so a new person can be pointed at one screen instead of a
 * README. It reports only whether each key is *present*; values never leave the
 * server (see src/lib/actions/setup.ts).
 *
 * Deliberately not exhaustive. .env.local also carries ~18 POSTGRES_*, PG* and
 * NEON_* variables, but those are provisioned automatically by the Vercel Neon
 * integration and nobody sets them by hand — listing them would bury the four
 * that actually need a decision.
 */

export type KeyScope = "app" | "local";

export type SetupKey = {
  name: string;
  /** One line, sentence case, no trailing period. */
  what: string;
  /**
   * "app"   — the running app reads it; must exist in .env.local AND on Vercel.
   * "local" — only CLI scripts read it, so it is absent in production by
   *           design and must never be reported as missing there.
   */
  scope: KeyScope;
  /** Where to obtain one, when it isn't something you invent yourself. */
  from?: string;
};

export const SETUP_KEYS: SetupKey[] = [
  {
    name: "DATABASE_URL",
    what: "Postgres connection",
    scope: "app",
    from: "Neon, via the Vercel marketplace integration",
  },
  {
    name: "APP_PASSCODE",
    what: "The passcode you sign in with",
    scope: "app",
  },
  {
    name: "SESSION_SECRET",
    what: "Signs the login cookie",
    scope: "app",
  },
  {
    name: "UNAVATAR_API_KEY",
    what: "Contact photo lookups",
    scope: "local",
    from: "unavatar.io/checkout",
  },
];

export type SkillInfo = { name: string; what: string };

/**
 * Claude Code skills committed under web/.claude/skills. Listed statically
 * rather than read off disk: the filesystem isn't reliably present on
 * serverless, and three entries are cheaper to keep honest than a runtime scan.
 */
export const SETUP_SKILLS: SkillInfo[] = [
  { name: "update-photos", what: "Fill in missing contact photos from LinkedIn" },
  { name: "linkedin-sync", what: "Sync headlines and role changes from LinkedIn" },
  { name: "gmail-sync", what: "Import recent emails into contact timelines" },
  { name: "neon", what: "Neon platform reference" },
  { name: "neon-postgres", what: "Postgres and database guidance" },
];

/** Presence only — never the value. */
export type SetupStatus = { name: string; present: boolean };
