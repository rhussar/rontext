"use server";

import { and, eq, gte } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { entities, entityLogos } from "@/db/schema";
import { MIN_HUB_SIZE } from "@/lib/graph/query";

export type LogoEntityRow = {
  id: number;
  name: string;
  memberCount: number;
  /** entity_logos.updated_at as epoch ms, null when no logo — doubles as a cache-buster */
  logoV: number | null;
};

/** Every company hub the graph draws, with its logo state. Drives the manager popover. */
export async function listLogoEntities(): Promise<LogoEntityRow[]> {
  const db = getDb();
  const hubs = await db
    .select({
      id: entities.id,
      name: entities.name,
      memberCount: entities.memberCount,
    })
    .from(entities)
    .where(and(eq(entities.type, "company"), gte(entities.memberCount, MIN_HUB_SIZE)));

  const logos = await db
    .select({ entityId: entityLogos.entityId, updatedAt: entityLogos.updatedAt })
    .from(entityLogos);
  const byId = new Map(logos.map((l) => [l.entityId, l.updatedAt.getTime()]));

  return hubs
    .map((h) => ({ ...h, logoV: byId.get(h.id) ?? null }))
    .sort((a, b) => b.memberCount - a.memberCount);
}

/**
 * Raster formats only — SVG is deliberately rejected. An SVG served from our
 * own origin can carry scripts, and /api/logos/[id] is a same-origin URL a
 * browser will happily navigate to.
 */
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);
const MAX_BYTES = 512_000;

export type LogoUploadResult = { ok: true } | { ok: false; error: string };

export async function uploadEntityLogo(
  entityId: number,
  formData: FormData,
): Promise<LogoUploadResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "No file received." };
  if (!ALLOWED_TYPES.has(file.type)) {
    return { ok: false, error: "Use a PNG, JPG, WebP, GIF or ICO image." };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: "Keep it under 500 KB — it renders at ~26px." };
  }

  const db = getDb();
  const [entity] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(eq(entities.id, entityId));
  if (!entity) return { ok: false, error: "Unknown entity." };

  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  await db
    .insert(entityLogos)
    .values({ entityId, data, contentType: file.type, domain: "upload" })
    .onConflictDoUpdate({
      target: entityLogos.entityId,
      set: { data, contentType: file.type, domain: "upload", updatedAt: new Date() },
    });

  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Download a logo the browser can't: pasting a LinkedIn image usually yields
 * only a CDN URL (Chrome copies an HTML reference, not a bitmap, for WebP),
 * and the CDN blocks cross-origin reads client-side. Server-side there's no
 * CORS, so fetch here and store through the same pipeline as an upload.
 */
export async function importEntityLogoFromUrl(
  entityId: number,
  url: string,
): Promise<LogoUploadResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "That doesn't look like an image link." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Only http(s) image links work here." };
  }
  // Cheap SSRF hygiene — this fetches an arbitrary user-supplied URL from the
  // server, so refuse obviously-internal destinations.
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(host) ||
    host.endsWith(".local")
  ) {
    return { ok: false, error: "That link points somewhere private." };
  }

  const db = getDb();
  const [entity] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(eq(entities.id, entityId));
  if (!entity) return { ok: false, error: "Unknown entity." };

  let res: Response;
  try {
    res = await fetch(parsed, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Rontext logo fetch)" },
    });
  } catch {
    return { ok: false, error: "Couldn't download that image." };
  }
  if (!res.ok) {
    return { ok: false, error: `The image link answered ${res.status}.` };
  }
  const type = (res.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    return { ok: false, error: "That link isn't a PNG, JPG, WebP, GIF or ICO." };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    return { ok: false, error: "That image link came back empty." };
  }
  if (buf.byteLength > MAX_BYTES) {
    return { ok: false, error: "Keep it under 500 KB — it renders at ~26px." };
  }

  await db
    .insert(entityLogos)
    .values({ entityId, data: buf.toString("base64"), contentType: type, domain: "upload" })
    .onConflictDoUpdate({
      target: entityLogos.entityId,
      set: {
        data: buf.toString("base64"),
        contentType: type,
        domain: "upload",
        updatedAt: new Date(),
      },
    });

  revalidatePath("/", "layout");
  return { ok: true };
}

export async function removeEntityLogo(entityId: number): Promise<void> {
  const db = getDb();
  await db.delete(entityLogos).where(eq(entityLogos.entityId, entityId));
  revalidatePath("/", "layout");
}
