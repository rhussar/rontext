import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === "/login") {
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

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Everything except Next internals, static assets, and PWA files
    "/((?!_next/static|_next/image|favicon\\.ico|icon|apple-icon|manifest\\.webmanifest|.*\\.(?:png|svg|jpg|jpeg|ico|webp)).*)",
  ],
};
