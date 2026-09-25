import { OAuthFailure, registerClient } from "@/lib/mcp-oauth";
import { jsonResponse, preflight } from "@/lib/oauth-http";

/**
 * RFC 7591 dynamic client registration. Open by design — registering grants
 * nothing; access only comes from the owner approving on /oauth/authorize.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, 400);
  }
  try {
    return jsonResponse(await registerClient(body), 201);
  } catch (e) {
    if (e instanceof OAuthFailure) return jsonResponse(e.toJSON(), e.status);
    throw e;
  }
}

export const OPTIONS = preflight;
