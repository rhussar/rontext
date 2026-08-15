import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contactDocs } from "@/db/schema";

// Auth: src/proxy.ts guards /api/* with the mesh_session cookie already.
//
// The path segment stays a bare numeric id on purpose. The proxy's matcher
// excludes anything ending in an image extension, so a route that carried the
// filename (".../resume.png") would slip past the session check entirely.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ docId: string }> },
) {
  const { docId } = await params;
  const id = parseInt(docId, 10);
  if (!Number.isFinite(id)) return new Response("Bad id", { status: 400 });

  const db = getDb();
  const [doc] = await db.select().from(contactDocs).where(eq(contactDocs.id, id));
  if (!doc) return new Response("Not found", { status: 404 });

  // The upload action verified the %PDF- magic bytes, so a fixed
  // application/pdf here is safe — nothing script-capable can land in this row.
  // Rows are never mutated (a replace is remove + upload under a new id), so
  // these bytes can cache hard, same as application docs and social media.
  //
  // `inline` renders in the browser's PDF viewer; the filename covers the user
  // hitting download from there. Quotes/backslashes/newlines are stripped so a
  // crafted filename can't inject a header.
  const filename = doc.filename.replace(/["\\\r\n]/g, "").slice(0, 200);
  return new Response(Buffer.from(doc.data, "base64"), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
