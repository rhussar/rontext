import { NextResponse, type NextRequest } from "next/server";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_DAYS,
  verifySessionToken,
} from "@/lib/session";
import { isDemo } from "@/lib/demo";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const demo = isDemo();

  if (pathname === "/login") {
    // The demo has no passcode to ask for — visitors are signed in below.
    if (demo) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // The MCP endpoint authenticates with its own bearer token (MCP_TOKEN),
  // checked inside the route — a session cookie is meaningless to an MCP
  // client, and a 307 to /login would break the protocol handshake. The route
  // fails closed when MCP_TOKEN is unset, so this exemption never exposes an
  // unauthenticated surface.
  if (pathname.startsWith("/api/mcp")) {
    return NextResponse.next();
  }

  // Same shape for the scheduler: Vercel Cron presents `Bearer CRON_SECRET`,
  // checked in the route, which 401s for everyone while the secret is unset.
  if (pathname.startsWith("/api/cron")) {
    return NextResponse.next();
  }

  // The Chrome extension's endpoints: bearer EXTENSION_TOKEN, checked in the
  // routes, fail closed when unset. Also answers CORS preflight there.
  if (pathname.startsWith("/api/ext/")) {
    return NextResponse.next();
  }

  // OAuth for MCP connectors (claude.ai): discovery documents, client
  // registration and the token endpoint are public by protocol — they
  // authenticate by what's in the request (PKCE, codes, client secrets),
  // never by cookie. The consent page itself (/oauth/authorize) is NOT
  // exempt: approving needs the passcode, which is the whole point.
  if (pathname.startsWith("/.well-known/") || pathname.startsWith("/api/oauth/mcp/")) {
    return NextResponse.next();
  }

  // Google's consent screen redirects the browser here. The route is gated by
  // the state cookie that /api/oauth/google/start (passcode-protected) minted,
  // so exempting it opens nothing an unauthenticated visitor can use.
  if (pathname === "/api/oauth/google/callback") {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token && (await verifySessionToken(token))) {
    return NextResponse.next();
  }

  // Demo mode: sign the visitor in on their first request instead of asking
  // for a passcode. Same cookie login() mints, so nothing downstream can tell
  // the difference; the database behind it holds only generated people and
  // every write path is closed (src/db/index.ts).
  if (demo) {
    const res = NextResponse.next();
    res.cookies.set(SESSION_COOKIE, await createSessionToken(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * SESSION_DAYS,
      path: "/",
    });
    return res;
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  // A connector's consent page must survive the detour through /login, or
  // the owner signs in and lands on Home with the authorization lost.
  if (pathname.startsWith("/oauth/")) {
    url.searchParams.set("next", pathname + request.nextUrl.search);
  }
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Everything except Next internals, static assets, and PWA files
    "/((?!_next/static|_next/image|favicon\\.ico|icon|apple-icon|manifest\\.webmanifest|.*\\.(?:png|svg|jpg|jpeg|ico|webp)).*)",
  ],
};
