/**
 * One-time Gmail pairing (from web/):
 *
 *   npx tsx scripts/pair-gmail.ts
 *
 * Opens Google's consent screen in your browser, catches the redirect on a
 * loopback listener, and writes the refresh token to ~/.mesh-replica/gmail.json
 * at mode 0600. Nothing is stored in the app's database.
 *
 * Before the first run you need a Google Cloud OAuth client:
 *   1. console.cloud.google.com → new project → enable the Gmail API
 *   2. OAuth consent screen → External → add yourself as the user
 *   3. PUBLISH the app ("In production"). You'll get an "unverified app"
 *      warning on the consent screen — click Advanced → Go to app. This step
 *      matters: while the app sits in Testing, Google expires refresh tokens
 *      for Gmail scopes every 7 days and you'd re-pair weekly.
 *   4. Credentials → Create OAuth client ID → application type "Desktop app"
 *
 * Then run this and paste the client ID and secret when asked.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import {
  GMAIL_SCOPE,
  TOKEN_PATH,
  saveCredentials,
  type GmailCredentials,
} from "./gmail-auth";

/**
 * Catch Google's redirect on 127.0.0.1. A desktop OAuth client accepts any
 * loopback port, which is why this needs no callback route in the Next.js app
 * and no exemption in the passcode proxy.
 */
function waitForCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<body style="font:16px system-ui;padding:3rem;text-align:center">${
          code ? "Gmail paired. You can close this tab." : `Pairing failed: ${error}`
        }</body>`,
      );
      server.close();
      if (code) resolve(code);
      else reject(new Error(error ?? "no code returned"));
    });
    server.listen(port, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the consent redirect"));
    }, 300_000).unref();
  });
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const clientId = (await rl.question("Google OAuth client ID: ")).trim();
  const clientSecret = (await rl.question("Google OAuth client secret: ")).trim();
  rl.close();

  if (!clientId || !clientSecret) {
    console.error("Both the client ID and secret are required.");
    process.exit(1);
  }

  const port = 8977;
  const redirectUri = `http://127.0.0.1:${port}`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GMAIL_SCOPE);
  // Both are required to get a refresh token back rather than only an access token.
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  console.log("\nOpening the consent screen. If it doesn't open, visit:\n");
  console.log(authUrl.toString() + "\n");
  execFile("open", [authUrl.toString()], () => {});

  const code = await waitForCode(port);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json()) as {
    refresh_token?: string;
    access_token?: string;
    error_description?: string;
  };
  if (!res.ok || !body.refresh_token) {
    console.error(
      `Token exchange failed: ${body.error_description ?? res.status}\n` +
        `If no refresh_token came back, revoke the app at ` +
        `myaccount.google.com/permissions and pair again.`,
    );
    process.exit(1);
  }

  const creds: GmailCredentials = {
    clientId,
    clientSecret,
    refreshToken: body.refresh_token,
  };

  // Record which mailbox this is, so a later sync can say what it's reading.
  if (body.access_token) {
    const profile = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { authorization: `Bearer ${body.access_token}` } },
    );
    if (profile.ok) {
      creds.emailAddress = ((await profile.json()) as { emailAddress?: string })
        .emailAddress;
    }
  }

  saveCredentials(creds);
  console.log(`\nPaired${creds.emailAddress ? ` as ${creds.emailAddress}` : ""}.`);
  console.log(`Token written to ${TOKEN_PATH} (mode 0600).`);
  console.log("\nNext: npx tsx scripts/ingest-gmail.ts --dry-run");
}

main();
