import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contactPhotos } from "@/db/schema";

// Auth: src/proxy.ts guards /api/* with the mesh_session cookie already.
export async function GET(
  _request: Request,
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

  return new Response(Buffer.from(photo.data, "base64"), {
    headers: {
      "Content-Type": photo.contentType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
