/**
 * GET /api/oauth/google/start — begin "Connect Google".
 *
 * Behind the passcode like every page (proxy), so only the signed-in owner
 * can start a flow. Mints a random `state`, parks it in a short-lived
 * HttpOnly cookie, and sends the browser to Google's consent screen asking
 * for the three read-only scopes. `access_type=offline` + `prompt=consent`
 * is what makes Google return a refresh token every time (without `consent`
 * a repeat authorization returns only an access token).
 *
 * The redirect URI is derived from the request origin (google-oauth-flow.ts),
 * so the same code serves localhost and production — both must be registered
 * on the OAuth client in Google Cloud, which the Setup hint spells out.
 */
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getGoogleClient, GOOGLE_SCOPES } from "@/lib/google-auth";
import { OAUTH_STATE_COOKIE, redirectUriFor } from "@/lib/google-oauth-flow";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const client = await getGoogleClient();
  if (!client) {
    return NextResponse.json(
      { error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set — add them in Settings → Setup." },
      { status: 400 },
    );
  }
  const state = randomBytes(16).toString("hex");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUriFor(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", Object.values(GOOGLE_SCOPES).join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);

  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/api/oauth/google",
    maxAge: 600,
  });
  return res;
}
