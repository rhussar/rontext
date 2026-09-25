import { OAuthFailure, parseBasicAuth, tokenRequest } from "@/lib/mcp-oauth";
import { jsonResponse, preflight } from "@/lib/oauth-http";

/**
 * The token endpoint: authorization_code (with PKCE) and refresh_token grants.
 * The spec'd body is form-encoded; JSON is accepted too, since some clients
 * send it.
 */
export async function POST(req: Request) {
  let params: Record<string, string | undefined> = {};
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const raw = (await req.json()) as Record<string, unknown>;
      params = Object.fromEntries(
        Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][],
      );
    } else {
      params = Object.fromEntries(new URLSearchParams(await req.text()));
    }
  } catch {
    return jsonResponse({ error: "invalid_request", error_description: "Unreadable body" }, 400);
  }

  try {
    return jsonResponse(await tokenRequest(params, parseBasicAuth(req.headers.get("authorization"))));
  } catch (e) {
    if (e instanceof OAuthFailure) {
      return jsonResponse(
        e.toJSON(),
        e.status,
        e.status === 401 ? { "WWW-Authenticate": 'Basic realm="rontext"' } : {},
      );
    }
    throw e;
  }
}

export const OPTIONS = preflight;
