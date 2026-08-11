/**
 * Turning an upload or a paste into bytes we're willing to store.
 *
 * Raster formats only — SVG is deliberately rejected. An SVG served back from
 * our own origin can carry scripts, and both /api/photos/[id] and
 * /api/logos/[id] are same-origin URLs a browser will happily navigate to.
 */
export const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

export type ImageIntake =
  | { ok: true; data: string; contentType: string }
  | { ok: false; error: string };

/** A file straight off an <input type="file"> or the clipboard. */
export async function imageFromFile(
  file: unknown,
  maxBytes: number,
  limitLabel: string,
): Promise<ImageIntake> {
  if (!(file instanceof File)) return { ok: false, error: "No file received." };
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return { ok: false, error: "Use a PNG, JPG, WebP, GIF or ICO image." };
  }
  if (file.size > maxBytes) {
    return { ok: false, error: `Keep it under ${limitLabel}.` };
  }
  return {
    ok: true,
    data: Buffer.from(await file.arrayBuffer()).toString("base64"),
    contentType: file.type,
  };
}

/**
 * Bytes already in hand as base64 — a vCard PHOTO property, say. Size is
 * checked against the *encoded* length (base64 is 4 chars per 3 bytes) so an
 * oversized payload is rejected without ever decoding it.
 */
export function imageFromBase64(
  data: string,
  contentType: string,
  maxBytes: number,
  limitLabel: string,
): ImageIntake {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    return { ok: false, error: "Use a PNG, JPG, WebP, GIF or ICO image." };
  }
  if (!data) return { ok: false, error: "That image came back empty." };
  if (Math.floor((data.length * 3) / 4) > maxBytes) {
    return { ok: false, error: `Keep it under ${limitLabel}.` };
  }
  return { ok: true, data, contentType: type };
}

/**
 * Validate an already-issued Response. Split out from imageFromUrl so callers
 * that must do their own fetch — the backfill script reads rate-limit and cost
 * headers off the response — still run byte-for-byte identical validation.
 */
export async function imageFromResponse(
  res: Response,
  maxBytes: number,
  limitLabel: string,
): Promise<ImageIntake> {
  if (!res.ok) return { ok: false, error: `The image link answered ${res.status}.` };

  const contentType = (res.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    return { ok: false, error: "That link isn't a PNG, JPG, WebP, GIF or ICO." };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    return { ok: false, error: "That image link came back empty." };
  }
  if (buf.byteLength > maxBytes) {
    return { ok: false, error: `Keep it under ${limitLabel}.` };
  }
  return { ok: true, data: buf.toString("base64"), contentType };
}

/**
 * Download an image the browser can't reach itself: pasting from LinkedIn
 * usually yields only a CDN URL (Chrome copies an HTML reference, not a
 * bitmap, for WebP), and that CDN blocks cross-origin reads client-side.
 * Server-side there's no CORS, so fetch it here instead.
 */
export async function imageFromUrl(
  url: string,
  maxBytes: number,
  limitLabel: string,
): Promise<ImageIntake> {
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

  let res: Response;
  try {
    res = await fetch(parsed, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Rontext image fetch)" },
    });
  } catch {
    return { ok: false, error: "Couldn't download that image." };
  }
  return imageFromResponse(res, maxBytes, limitLabel);
}
