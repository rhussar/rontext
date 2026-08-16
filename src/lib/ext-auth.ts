/**
 * Auth + CORS for /api/ext/* — the Chrome extension's endpoints.
 *
 * Bearer EXTENSION_TOKEN (Setup → Generate), checked with timingSafeEqual and
 * read through the 60s cache like the MCP route: the extension can chatter,
 * and an unauthenticated probe shouldn't cost a Neon round trip. Unset token
 * → 401 for everyone (fails closed), which is what makes the proxy exemption
 * for /api/ext safe.
 *
 * CORS is `*` on purpose: the app URL is whatever the user pasted into the
 * extension (production, a preview, localhost), and the only credential is
 * the bearer header — browsers never attach that on their own, so there is no
 * ambient-authority request to protect against. The passcode cookie is
 * irrelevant here (the proxy doesn't gate these paths).
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSecretCached } from "@/lib/secrets";
import { getDb } from "@/db";
import { appState } from "@/db/schema";

export const EXT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-rontext-extension",
  "Access-Control-Max-Age": "600",
};

export async function extAuthorized(req: Request): Promise<boolean> {
  const token = await getSecretCached("EXTENSION_TOKEN");
  if (!token) return false;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function extJson(data: unknown, init: ResponseInit = {}): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: { ...EXT_CORS_HEADERS, ...(init.headers ?? {}) },
  });
}

export function extUnauthorized(): NextResponse {
  return extJson({ error: "unauthorized" }, { status: 401 });
}

export function extOptions(): NextResponse {
  return new NextResponse(null, { status: 204, headers: EXT_CORS_HEADERS });
}

export const EXT_LAST_SEEN_KEY = "ext:lastSeenAt";
export const EXT_VERSION_KEY = "ext:version";

/** "Last seen" for the LinkedIn card. Awaited by callers — serverless drops fire-and-forget writes. */
export async function stampExtensionSeen(req: Request): Promise<void> {
  const now = new Date();
  const version = req.headers.get("x-rontext-extension")?.slice(0, 40) ?? "";
  const rows = [
    { key: EXT_LAST_SEEN_KEY, value: now.toISOString() },
    ...(version ? [{ key: EXT_VERSION_KEY, value: version }] : []),
  ];
  const db = getDb();
  for (const r of rows) {
    await db
      .insert(appState)
      .values({ ...r, updatedAt: now })
      .onConflictDoUpdate({ target: appState.key, set: { value: r.value, updatedAt: now } });
  }
}

/** "YYYY-MM-DD" in UTC — the day key for the visit counter. */
export function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
export const visitsKey = (day = todayKey()) => `ext:activeVisits:${day}`;
