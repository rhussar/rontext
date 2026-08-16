/**
 * One-time: move the Gmail grant from this Mac into the app, so the daily
 * cron job can read Gmail without this machine being awake.
 *
 *   set -a && source .env.local && set +a && npx tsx scripts/migrate-gmail-token.ts [--dry-run] [--delete-file]
 *
 * Reads ~/.mesh-replica/gmail.json (client id/secret, refresh token, address)
 * and writes it through saveGoogleGrant() — the same write-only secret store
 * Settings → Setup uses. The file is left in place unless --delete-file, so
 * the CLI scripts keep working either way (they now read the app store first
 * and fall back to the file).
 *
 * The scopes are recorded as gmail-only, which is what pair-gmail.ts asked
 * for. Contacts and Calendar need a re-consent through Settings → Accounts →
 * Connect Google (a *Web* OAuth client, since a Desktop client can't redirect
 * to an https URL).
 */
import { unlinkSync } from "node:fs";
import { loadCredentials, TOKEN_PATH } from "./gmail-auth";
import { GOOGLE_SCOPES, getGoogleConnection, saveGoogleGrant } from "../src/lib/google-auth";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const deleteFile = process.argv.includes("--delete-file");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — source .env.local first.");

  const creds = loadCredentials();
  if (!creds) {
    console.log(`No token file at ${TOKEN_PATH}. Nothing to migrate.`);
    return;
  }
  const before = await getGoogleConnection();
  console.log(`token file:   ${TOKEN_PATH} (${creds.emailAddress ?? "address unknown"})`);
  console.log(`app store:    ${before.connected ? `already connected as ${before.email ?? "?"} (${before.scopes.join(", ")})` : "not connected"}`);
  if (before.connected && before.scopes.length > 1) {
    console.log("The app already holds a broader grant than the file — leaving it alone.");
    return;
  }
  if (dryRun) {
    console.log("[dry-run] would write client id/secret + refresh token to the app store.");
    return;
  }
  await saveGoogleGrant({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken: creds.refreshToken,
    email: creds.emailAddress?.toLowerCase() ?? null,
    scopes: [GOOGLE_SCOPES.gmail],
    clientType: "desktop",
  });
  const after = await getGoogleConnection();
  console.log(`migrated:     connected as ${after.email ?? "?"} · scopes: ${after.scopes.join(", ")}`);
  if (deleteFile) {
    unlinkSync(TOKEN_PATH);
    console.log(`deleted:      ${TOKEN_PATH}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
