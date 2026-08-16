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

export type KeyScope = "bootstrap" | "app" | "local";

export type SetupKey = {
  name: string;
  /** One line, sentence case, no trailing period. */
  what: string;
  /**
   * "bootstrap" — the app can't start (or can't be trusted) without it, and it
   *               cannot live in the database it unlocks. Env-only, status-only
   *               in the UI, never editable there.
   * "app"       — the running app reads it. Editable in Settings → Setup:
   *               stored write-only in app_state (secret:<NAME>), env fallback.
   * "local"     — only CLI scripts read it. Still editable in the UI (the
   *               scripts reach the same database), but absence is never a
   *               problem — the label describes where it *runs*. Currently
   *               empty: UNAVATAR_API_KEY and GITHUB_TOKEN moved to "app" when
   *               the daily jobs started reading them on Vercel.
   */
  scope: KeyScope;
  /** Where to obtain one, when it isn't something you invent yourself. */
  from?: string;
};

export const SETUP_KEYS: SetupKey[] = [
  {
    name: "DATABASE_URL",
    what: "Postgres connection",
    scope: "bootstrap",
    from: "Neon, via the Vercel marketplace integration",
  },
  {
    name: "APP_PASSCODE",
    what: "The passcode you sign in with",
    scope: "bootstrap",
  },
  {
    name: "SESSION_SECRET",
    what: "Signs the login cookie",
    scope: "bootstrap",
  },
  // Env-only like the other bootstrap keys, but for a different reason: it
  // authenticates the *scheduler* (Vercel Cron sends it as a bearer on
  // /api/cron/daily). A value editable from inside the app would let the app
  // grant itself scheduling; unset, the route 401s for everyone.
  {
    name: "CRON_SECRET",
    what: "Lets Vercel Cron call /api/cron/daily · unset disables the schedule",
    scope: "bootstrap",
    from: "invent one — e.g. openssl rand -hex 32; Vercel sends it automatically once set",
  },
  {
    name: "ANTHROPIC_API_KEY",
    what: "AI drafting · sends contact details to Anthropic",
    scope: "app",
    from: "console.anthropic.com",
  },
  {
    name: "MCP_TOKEN",
    what: "MCP server auth · lets AI agents read contacts and write notes/reminders/drafts via /api/mcp",
    scope: "app",
    from: "invent one — e.g. openssl rand -hex 32; unset disables the endpoint",
  },
  {
    name: "EXTENSION_TOKEN",
    what: "Chrome extension auth · lets the Rontext extension post LinkedIn captures to /api/ext",
    scope: "app",
    from: "Generate here, then paste it (with this app's URL) into the extension's options page; unset disables the endpoint",
  },
  // The OAuth *client* for "Connect Google". The refresh token itself is not a
  // Setup key — it's minted by /api/oauth/google/callback and cleared by
  // Disconnect, never pasted.
  {
    name: "GOOGLE_CLIENT_ID",
    what: "Connect Google · Gmail, Calendar and Contacts (read-only) sync daily",
    scope: "app",
    from: "console.cloud.google.com → Credentials → OAuth client, type Web application; add <your-app-url>/api/oauth/google/callback (and http://localhost:3000/... for dev) as an authorized redirect URI; enable the Gmail, People and Calendar APIs; publish the consent screen",
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    what: "Connect Google · the client's secret",
    scope: "app",
    from: "same OAuth client as GOOGLE_CLIENT_ID",
  },
  {
    name: "UNAVATAR_API_KEY",
    what: "Contact photo lookups · the daily job spends up to the budget in Settings → General",
    scope: "app",
    from: "unavatar.io/checkout",
  },
  {
    name: "GITHUB_TOKEN",
    what: "GitHub follower and repo traffic stats · refreshed daily",
    scope: "app",
    from: "github.com/settings/tokens — traffic needs push access to your repos",
  },
  {
    name: "BLOB_READ_WRITE_TOKEN",
    what: "Nightly JSON backups to Vercel Blob (private, 30-day retention)",
    scope: "app",
    from: "Vercel → Storage → create a Blob store and connect it to the project",
  },
  // The four OAuth 1.0a values for posting to X, generated together in the
  // developer portal. Set the app to "Read and write" BEFORE generating the
  // access token — a token minted read-only stays read-only.
  {
    name: "X_API_KEY",
    what: "Posting to X · API key",
    scope: "app",
    from: "developer.x.com → your project → Keys and tokens",
  },
  {
    name: "X_API_SECRET",
    what: "Posting to X · API key secret",
    scope: "app",
    from: "developer.x.com → your project → Keys and tokens",
  },
  {
    name: "X_ACCESS_TOKEN",
    what: "Posting to X · access token",
    scope: "app",
    from: "developer.x.com → your project → Keys and tokens",
  },
  {
    name: "X_ACCESS_SECRET",
    what: "Posting to X · access token secret",
    scope: "app",
    from: "developer.x.com → your project → Keys and tokens",
  },
];

/*
 * The skill list used to live here as a hand-maintained constant. It drifted —
 * the comment claimed three entries while the array held six, and it never
 * gained `messages-sync`. It is now a directory scan in src/lib/skills.ts, with
 * next.config.ts bundling the files so the scan works on serverless too.
 */

/**
 * Presence and provenance only — never the value. `source` says where the
 * effective value comes from: "app" = stored via the Settings UI (DB wins over
 * env), "env" = environment variable, null = missing. It is metadata about a
 * secret, not the secret; the never-widen-to-values rule still holds.
 */
export type SetupStatus = {
  name: string;
  present: boolean;
  source: "app" | "env" | null;
};
