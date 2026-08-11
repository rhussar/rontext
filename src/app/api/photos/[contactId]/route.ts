import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contactPhotos } from "@/db/schema";

// Auth: src/proxy.ts guards /api/* with the mesh_session cookie already.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const { contactId } = await params;
  const id = parseInt(contactId, 10);
  if (!Number.isFinite(id)) return new Response("Bad id", { status: 400 });

  const db = getDb();
  const [photo] = await db
    .select()
    .from(contactPhotos)
    .where(eq(contactPhotos.contactId, id));
  if (!photo) return new Response("Not found", { status: 404 });

  /**
   * `no-cache` means "revalidate before reusing", not "don't store" — the
   * browser still keeps the bytes and we still answer 304s. A plain max-age
   * would pin a replaced photo on screen until it expired, since editing one
   * doesn't change this URL.
   */
  const etag = `"p${id}-${photo.updatedAt.getTime()}"`;
  const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(Buffer.from(photo.data, "base64"), {
    headers: { ...headers, "Content-Type": photo.contentType },
  });
}
