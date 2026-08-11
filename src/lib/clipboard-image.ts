"use client";

/**
 * Pull an image out of a paste event's clipboard data. Covers the ⌘V case —
 * right-click "Copy image" on LinkedIn puts a real image (usually PNG) on
 * the OS clipboard, which browsers hand back through DataTransferItem.
 *
 * Typed as `{ clipboardData }` rather than React's or the DOM's ClipboardEvent
 * specifically — both a native `document.addEventListener("paste", ...)`
 * event and React's synthetic one satisfy this, so callers don't need a cast.
 */
export function imageFromClipboardEvent(e: {
  clipboardData: DataTransfer | null;
}): File | null {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.type.startsWith("image/")) return item.getAsFile();
  }
  return null;
}

/** What a paste can carry: a real bitmap, or just a link to one. */
export type ClipboardImage =
  | { kind: "file"; file: File }
  | { kind: "url"; url: string };

/** First <img src="http(s)://…"> in a clipboard HTML fragment, or null. */
function firstImageUrlFromHtml(html: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const src = doc.querySelector("img[src]")?.getAttribute("src") ?? null;
    if (src && /^https?:\/\//i.test(src)) return src;
  } catch {
    // Unparseable fragment — nothing to extract
  }
  return null;
}

/** URL-shaped ⌘V paste from an event's clipboard data, when there's no bitmap. */
export function imageUrlFromClipboardEvent(e: {
  clipboardData: DataTransfer | null;
}): string | null {
  const html = e.clipboardData?.getData("text/html") ?? "";
  const fromHtml = firstImageUrlFromHtml(html);
  if (fromHtml) return fromHtml;
  const text = (e.clipboardData?.getData("text/plain") ?? "").trim();
  return /^https?:\/\/\S+$/i.test(text) ? text : null;
}

/**
 * Async Clipboard API read, for an explicit "Paste image" button — covers
 * people who don't know/use ⌘V. Needs a secure context and clipboard-read
 * permission; returns null on anything from an empty clipboard to a denied
 * prompt rather than throwing, since "nothing to paste" and "not allowed"
 * both just mean fall back to Upload.
 *
 * The URL fallback is the LinkedIn case: Chrome's "Copy image" there usually
 * puts a `text/html` fragment referencing the CDN image on the clipboard,
 * NOT a bitmap (LinkedIn serves WebP, which Chrome won't transcode). The
 * browser can't fetch that URL itself — the CDN blocks cross-origin reads —
 * so the caller ships it to a server action to download instead.
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  if (!navigator.clipboard?.read) return null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      return {
        kind: "file",
        file: new File([blob], `pasted.${type.split("/")[1] ?? "png"}`, { type }),
      };
    }
    // No bitmap — look for an image reference in the HTML/text flavors
    for (const item of items) {
      if (item.types.includes("text/html")) {
        const html = await (await item.getType("text/html")).text();
        const url = firstImageUrlFromHtml(html);
        if (url) return { kind: "url", url };
      }
    }
    for (const item of items) {
      if (item.types.includes("text/plain")) {
        const text = (await (await item.getType("text/plain")).text()).trim();
        if (/^https?:\/\/\S+$/i.test(text)) return { kind: "url", url: text };
      }
    }
  } catch {
    // Permission denied or nothing readable — treat like "no image found"
  }
  return null;
}
