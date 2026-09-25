"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  approveAuthorization,
  AUTHORIZE_PARAMS,
  denyAuthorization,
  OAuthFailure,
  validateAuthorizeRequest,
} from "@/lib/mcp-oauth";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * The consent form's submit. Every hidden field is re-validated here — the
 * form is just a carrier, and a tampered redirect_uri must fail the same way
 * it would have on the page. The session is checked again too: the proxy
 * already requires it, but this is the one action that mints credentials.
 */
export async function decideAuthorization(formData: FormData): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySessionToken(token))) redirect("/login");

  const params: Record<string, string | undefined> = {};
  for (const k of AUTHORIZE_PARAMS) {
    const v = formData.get(k);
    if (typeof v === "string" && v) params[k] = v;
  }
  const v = await validateAuthorizeRequest(params);
  if (!v.ok) {
    if ("redirect" in v) redirect(v.redirect);
    throw new Error(v.show);
  }

  if (formData.get("decision") !== "approve") redirect(denyAuthorization(v.req));

  // Never more than the client asked for, whatever the form says.
  const access =
    formData.get("access") === "write" && v.req.requestedAccess === "write" ? "write" : "read";
  const agentKey = String(formData.get("agent_key") ?? "").trim().toLowerCase();

  let target: string;
  try {
    target = await approveAuthorization(v.req, { agentKey, access });
  } catch (e) {
    if (!(e instanceof OAuthFailure)) throw e;
    // Back to the consent page with the problem shown, parameters intact.
    const back = new URLSearchParams(params as Record<string, string>);
    back.set("problem", e.message);
    target = `/oauth/authorize?${back.toString()}`;
  }
  redirect(target);
}
