import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { entityLogos } from "@/db/schema";

// Auth: src/proxy.ts guards /api/* with the mesh_session cookie already.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ entityId: string }> },
) {
  const { entityId } = await params;
  const id = parseInt(entityId, 10);
  if (!Number.isFinite(id)) return new Response("Bad id", { status: 400 });

  const db = getDb();
  const [logo] = await db
    .select()
    .from(entityLogos)
    .where(eq(entityLogos.entityId, id));
  if (!logo) return new Response("Not found", { status: 404 });

  return new Response(Buffer.from(logo.data, "base64"), {
    headers: {
      "Content-Type": logo.contentType,
      // Logos change about never; the canvas re-requests one per node per load.
      "Cache-Control": "private, max-age=86400",
    },
  });
}
