import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { applicationDocs } from "@/db/schema";

// Auth: src/proxy.ts guards /api/* with the mesh_session cookie already.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ docId: string }> },
) {
  const { docId } = await params;
  const id = parseInt(docId, 10);
  if (!Number.isFinite(id)) return new Response("Bad id", { status: 400 });

  const db = getDb();
  const [doc] = await db
    .select()
    .from(applicationDocs)
    .where(eq(applicationDocs.id, id));
  if (!doc) return new Response("Not found", { status: 404 });

  // The upload action verified the %PDF- magic bytes, so serving a fixed
  // application/pdf here is safe — nothing script-capable can land in this row.
  // Rows are immutable (replace = delete + re-insert under a new id), so these
  // bytes can cache hard, same as social post media.
  //
  // `inline` renders in the browser's PDF viewer; the filename covers the
  // user hitting download from there.
  const filename = doc.filename.replace(/["\\\r\n]/g, "").slice(0, 200);
  return new Response(Buffer.from(doc.data, "base64"), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
