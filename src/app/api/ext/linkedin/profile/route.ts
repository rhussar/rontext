/**
 * POST /api/ext/linkedin/profile — one captured LinkedIn profile from the
 * Chrome extension (passive: a page the owner opened; active: one of the
 * day's due visits).
 *
 * Never creates a contact: the extension sees every profile the owner
 * happens to browse, and a connector must never auto-create (same rule as
 * Gmail/Messages). Unknown URLs get {matched:false} and nothing is written.
 * Matched ones go through the same non-blanking merge the linkedin-sync skill
 * uses (ingestLinkedinProfiles), so headline changes show up as "Recent
 * updates" exactly as before — the extension just replaced Claude's hands.
 *
 * Photos arrive as base64 fetched by the extension's background worker (which
 * has host permission for media.licdn.com and the user's session — the one
 * path the five dead ends in the photo memory never covered), and are stored
 * fill-gaps-only through the single photo writer.
 *
 * A day's captures fold into ONE scrape_runs row (source "extension") so the
 * activity feed doesn't get a line per profile.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { appState, contactPhotos, scrapeRuns } from "@/db/schema";
import { extAuthorized, extJson, extOptions, extUnauthorized, stampExtensionSeen, visitsKey } from "@/lib/ext-auth";
import { imageFromBase64 } from "@/lib/image-import";
import { ingestLinkedinProfiles } from "@/lib/linkedin-ingest";
import { PHOTO_LIMIT_LABEL, PHOTO_MAX_BYTES, storeContactPhoto } from "@/lib/photos";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const bodySchema = z.object({
  linkedinUrl: z.string().min(10).max(500),
  fullName: z.string().max(200).nullish(),
  headline: z.string().max(500).nullish(),
  title: z.string().max(300).nullish(),
  company: z.string().max(300).nullish(),
  school: z.string().max(300).nullish(),
  location: z.string().max(300).nullish(),
  photo: z
    .object({ data: z.string().max(3_000_000), contentType: z.string().max(60) })
    .nullish(),
  mode: z.enum(["passive", "active"]).default("passive"),
});

export function OPTIONS() {
  return extOptions();
}

export async function POST(req: Request) {
  if (!(await extAuthorized(req))) return extUnauthorized();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return extJson({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return extJson({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }
  const p = parsed.data;

  const summary = await ingestLinkedinProfiles(
    [
      {
        linkedinUrl: p.linkedinUrl,
        fullName: p.fullName ?? undefined,
        headline: p.headline ?? undefined,
        title: p.title ?? undefined,
        company: p.company ?? undefined,
        school: p.school ?? undefined,
        location: p.location ?? undefined,
      },
    ],
    { createMissing: false, recordRun: false },
  );
  await stampExtensionSeen(req);
  if (!summary.ok) return extJson({ error: summary.error ?? "ingest failed" }, { status: 400 });

  const db = getDb();
  if (p.mode === "active") {
    // Server-side visit counter — the due endpoint enforces the daily cap
    // from this, so a misbehaving extension can't out-visit Settings.
    await db
      .insert(appState)
      .values({ key: visitsKey(), value: "1", updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appState.key,
        set: { value: sql`(coalesce(nullif(${appState.value}, ''), '0')::int + 1)::text`, updatedAt: new Date() },
      });
  }

  if (summary.skipped) {
    return extJson({ ok: true, matched: false });
  }
  const contactId = summary.contactIds[0];

  let photoStored = false;
  if (p.photo && contactId) {
    const intake = imageFromBase64(p.photo.data, p.photo.contentType, PHOTO_MAX_BYTES, PHOTO_LIMIT_LABEL);
    const saved = await storeContactPhoto(contactId, intake, "linkedin", { fillGapsOnly: true });
    photoStored = saved.ok && saved.stored;
  }
  // Tell the extension whether fetching the avatar is worth it — it only
  // pulls bytes for people who don't have one yet (see ../photo/route.ts).
  const [hasPhoto] = contactId
    ? await db.select({ id: contactPhotos.contactId }).from(contactPhotos).where(eq(contactPhotos.contactId, contactId)).limit(1)
    : [];

  // Fold into today's extension run row.
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const [today] = await db
    .select({ id: scrapeRuns.id })
    .from(scrapeRuns)
    .where(and(eq(scrapeRuns.source, "extension"), gte(scrapeRuns.createdAt, dayStart)))
    .limit(1);
  const inc = { updated: summary.updated, unchanged: summary.unchanged, changes: summary.changesLogged };
  if (today) {
    await db
      .update(scrapeRuns)
      .set({
        profileCount: sql`${scrapeRuns.profileCount} + 1`,
        updatedCount: sql`${scrapeRuns.updatedCount} + ${inc.updated}`,
        unchangedCount: sql`${scrapeRuns.unchangedCount} + ${inc.unchanged}`,
        changeCount: sql`${scrapeRuns.changeCount} + ${inc.changes}`,
        // Advance to the newest capture. The row is folded all day, so a
        // frozen timestamp buried this morning's row under the afternoon's
        // individual changes and, once the activity menu was read, kept the
        // unread dot from coming back for the rest of the day. Still inside
        // the UTC day, so the day-bucket lookup above still finds it.
        createdAt: new Date(),
      })
      .where(eq(scrapeRuns.id, today.id));
  } else {
    await db.insert(scrapeRuns).values({
      source: "extension",
      profileCount: 1,
      createdCount: 0,
      updatedCount: inc.updated,
      unchangedCount: inc.unchanged,
      changeCount: inc.changes,
    });
  }

  return extJson({
    ok: true,
    matched: true,
    contactId,
    changes: summary.changes.map((c) => ({ field: c.field, old: c.old, new: c.new })),
    photoStored,
    schoolAdded: summary.schoolsAdded > 0,
    needsPhoto: !hasPhoto && !photoStored,
  });
}
