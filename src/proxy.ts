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
