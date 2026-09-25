import { protectedResourceMetadata } from "@/lib/mcp-oauth";
import { jsonResponse, preflight, publicOrigin } from "@/lib/oauth-http";

/**
 * RFC 9728 protected-resource metadata: "the MCP endpoint is guarded by this
 * authorization server". Where a client lands after /api/mcp answers 401. The
 * optional catch-all also answers the path-suffixed form clients try first
 * (/.well-known/oauth-protected-resource/api/mcp).
 */
export function GET(req: Request) {
  return jsonResponse(protectedResourceMetadata(publicOrigin(req)));
}

export const OPTIONS = preflight;
