"use client";

/**
 * Shrink an image in the browser before it goes anywhere near a server
 * action. Post images land as base64 rows in Postgres, so a 12MP phone photo
 * must not arrive as-is — 1600px is plenty for a feed preview.
 */

export type DownscaledImage = {
  file: File;
  /** Object URL for immediate preview — caller revokes when done. */
  previewUrl: string;
  width: number;
  height: number;
};

const RECODE_QUALITY = 0.85;

export async function downscaleImage(
  original: File,
  maxDim = 1600,
  maxBytes = 1_000_000,
): Promise<DownscaledImage | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(original);
  } catch {
    return null;
  }

  const { width, height } = bitmap;
  const oversize = width > maxDim || height > maxDim;

  // GIFs pass through untouched when small enough — a canvas re-encode
  // freezes the animation, which is worse than a few hundred extra KB.
  const isGif = original.type === "image/gif";
  if ((!oversize && original.size <= maxBytes) || (isGif && original.size <= maxBytes)) {
    bitmap.close();
    return {
      file: original,
      previewUrl: URL.createObjectURL(original),
      width,
      height,
    };
  }

  const scale = oversize ? Math.min(maxDim / width, maxDim / height) : 1;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return null;
  }
  // JPEG has no alpha — flatten onto white rather than onto black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", RECODE_QUALITY),
  );
  if (!blob) return null;

  const file = new File([blob], original.name.replace(/\.\w+$/, "") + ".jpg", {
    type: "image/jpeg",
  });
  return { file, previewUrl: URL.createObjectURL(file), width: w, height: h };
}
