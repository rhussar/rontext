/**
 * GET /api/oauth/google/callback — Google sends the browser back here.
 *
 * Exempted from the passcode proxy: the session cookie is SameSite=Lax and
 * would survive this top-level redirect in most browsers, but the exemption
 * makes the flow independent of that. What actually gates the callback is the
 * `state` cookie minted by /start — which *is* behind the passcode — so a
 * request without a matching state cookie is rejected before any token
 * exchange. Nothing here reads a secret from the query string; the code is
 * single-use and exchanged server-to-server.
 *
 * On success the refresh token lands in the write-only secret store, the
 * account address and granted scopes in app_state, and the browser goes back
 * to the app. On any failure it goes back with ?google=error&reason=… so the
 * Accounts card can say what happened instead of a bare JSON page.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { fetchGmailAddress, getGoogleClient, saveGoogleGrant } from "@/lib/google-auth";
import { OAUTH_STATE_COOKIE, redirectUriFor } from "@/lib/google-oauth-flow";

export const dynamic = "force-dynamic";

function back(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL("/", redirectUriFor(req));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/api/oauth/google", maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const expected = req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? "";
  const presented = q.get("state") ?? "";
  const stateOk =
    expected.length > 0 &&
    expected.length === presented.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
  if (!stateOk) return back(req, { google: "error", reason: "state" });

  if (q.get("error")) return back(req, { google: "error", reason: q.get("error")! });
  const code = q.get("code");
  if (!code) return back(req, { google: "error", reason: "no_code" });

  const client = await getGoogleClient();
  if (!client) return back(req, { google: "error", reason: "no_client" });

  let tokens: {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirectUriFor(req),
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    tokens = await res.json();
    if (!res.ok) return back(req, { google: "error", reason: tokens.error ?? `http_${res.status}` });
  } catch {
    return back(req, { google: "error", reason: "exchange_failed" });
  }
  if (!tokens.refresh_token) {
    // Happens when Google decides the app already has a grant and skips
    // re-consent despite prompt=consent — rare, but the fix is on their side.
    return back(req, { google: "error", reason: "no_refresh_token" });
  }

  const email = tokens.access_token ? await fetchGmailAddress(tokens.access_token) : null;
  await saveGoogleGrant({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    refreshToken: tokens.refresh_token,
    email,
    scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean),
    clientType: "web",
  });
  return back(req, { google: "connected" });
}
