/**
 * HTTP plumbing shared by the OAuth endpoints. They're called by MCP clients,
 * some running in a browser, so every response carries permissive CORS — the
 * endpoints are public by design and authenticate by what's in the request,
 * never by cookies.
 */
import { getPublicOrigin } from "mcp-handler";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

/** The public origin, honoring the proxy's forwarded host (Vercel sets it). */
export const publicOrigin = (req: Request) => getPublicOrigin(req);

export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Tokens and registrations must never be cached anywhere in between.
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
