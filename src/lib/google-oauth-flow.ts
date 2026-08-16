/**
 * Shared bits of the two-step "Connect Google" flow (start → callback).
 * Route files may only export handlers, so the cookie name and the redirect
 * URI derivation live here.
 */
import type { NextRequest } from "next/server";

export const OAUTH_STATE_COOKIE = "google_oauth_state";

/**
 * The callback URL for *this* deployment. Behind Vercel the request URL is
 * already the public origin; locally it's http://localhost:3000. Both must be
 * registered on the OAuth client in Google Cloud (Credentials → the Web
 * client → Authorized redirect URIs).
 */
export function redirectUriFor(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  return `${proto}://${host}/api/oauth/google/callback`;
}
