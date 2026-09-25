import { authorizationServerMetadata } from "@/lib/mcp-oauth";
import { jsonResponse, preflight, publicOrigin } from "@/lib/oauth-http";

/** RFC 8414 authorization-server metadata: where to register, authorize and get tokens. */
export function GET(req: Request) {
  return jsonResponse(authorizationServerMetadata(publicOrigin(req)));
}

export const OPTIONS = preflight;
