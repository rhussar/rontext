import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { socialPostMedia } from "@/db/schema";

// Auth: src/proxy.ts guards /api/* with the mesh_session cookie already.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> },
) {
  const { mediaId } = await params;
  const id = parseInt(mediaId, 10);
  if (!Number.isFinite(id)) return new Response("Bad id", { status: 400 });

  const db = getDb();
  const [media] = await db
    .select()
    .from(socialPostMedia)
    .where(eq(socialPostMedia.id, id));
  if (!media) return new Response("Not found", { status: 404 });

  // Unlike contact photos, a media row is immutable (replace = delete +
  // re-add under a new id), so these bytes can cache hard.
  return new Response(Buffer.from(media.data, "base64"), {
    headers: {
      "Content-Type": media.contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
