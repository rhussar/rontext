import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, meetingContacts, meetings } from "@/db/schema";
import { meetingFilename, meetingMarkdown } from "@/lib/meetings";

// Auth: src/proxy.ts guards /api/* with the session cookie already. The path
// ends in "/md", not ".md", on purpose — see the contact-docs route: the
// proxy's matcher skips file-extension paths, which would bypass the check.
//
// ?tz=America/New_York renders "When" in the viewer's zone (the server is UTC).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const { meetingId } = await params;
  const id = parseInt(meetingId, 10);
  if (!Number.isFinite(id)) return new Response("Bad id", { status: 400 });

  const db = getDb();
  const [m] = await db.select().from(meetings).where(eq(meetings.id, id));
  if (!m) return new Response("Not found", { status: 404 });
  const people = await db
    .select({ fullName: contacts.fullName })
    .from(meetingContacts)
    .innerJoin(contacts, eq(contacts.id, meetingContacts.contactId))
    .where(eq(meetingContacts.meetingId, id));

  const tz = new URL(request.url).searchParams.get("tz") ?? undefined;
  const body = meetingMarkdown(m, people.map((p) => p.fullName), tz);
  const filename = meetingFilename(m);
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return new Response(body, {
    headers: {
      // text/plain-family, never text/html — the body is notetaker output.
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
