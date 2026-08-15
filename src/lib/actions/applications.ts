"use server";

import { desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  applicationDocs,
  applications,
  type Application,
  type ApplicationDocKind,
} from "@/db/schema";

/**
 * PDFs only, capped at 5MB. The cap needs headroom in next.config.ts's
 * serverActions.bodySizeLimit — the multipart wrapper adds a few KB on top
 * of the file itself.
 */
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const PDF_LIMIT_LABEL = "5MB";

function revalidateAll() {
  revalidatePath("/", "layout");
}

/**
 * Pasted job links arrive in every shape — "boards.greenhouse.io/x/jobs/1"
 * included. Store something an <a href> can actually open: empty → null,
 * scheme-less → https://.
 */
function normalizeUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export type ApplicationDocMeta = {
  id: number;
  kind: ApplicationDocKind;
  filename: string;
  byteSize: number;
};

export type ApplicationListItem = {
  id: number;
  company: string;
  role: string;
  /** "YYYY-MM-DD" or null. */
  appliedOn: string | null;
  url: string | null;
  notes: string;
  /** ISO — a Date doesn't cross into a client component's props cleanly. */
  createdAt: string;
  resume: ApplicationDocMeta | null;
  coverLetter: ApplicationDocMeta | null;
};

export async function listApplications(): Promise<ApplicationListItem[]> {
  const db = getDb();
  const [apps, docs] = await Promise.all([
    db
      .select()
      .from(applications)
      // Undated rows sort last, not first — Postgres defaults nulls first on desc.
      .orderBy(
        sql`${applications.appliedOn} desc nulls last`,
        desc(applications.createdAt),
      ),
    // Explicit column list: the base64 PDF bytes must never ride the list query.
    db
      .select({
        id: applicationDocs.id,
        applicationId: applicationDocs.applicationId,
        kind: applicationDocs.kind,
        filename: applicationDocs.filename,
        byteSize: applicationDocs.byteSize,
      })
      .from(applicationDocs),
  ]);

  const byApp = new Map<number, ApplicationDocMeta[]>();
  for (const d of docs) {
    const list = byApp.get(d.applicationId) ?? [];
    list.push({ id: d.id, kind: d.kind, filename: d.filename, byteSize: d.byteSize });
    byApp.set(d.applicationId, list);
  }

  return apps.map((a) => {
    const appDocs = byApp.get(a.id) ?? [];
    return {
      id: a.id,
      company: a.company,
      role: a.role,
      appliedOn: a.appliedOn,
      url: a.url,
      notes: a.notes,
      createdAt: a.createdAt.toISOString(),
      resume: appDocs.find((d) => d.kind === "resume") ?? null,
      coverLetter: appDocs.find((d) => d.kind === "cover_letter") ?? null,
    };
  });
}

export async function createApplication(
  company: string,
  role: string,
  appliedOn: string | null,
  url?: string | null,
): Promise<Application> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      company: company.trim(),
      role: role.trim(),
      appliedOn: appliedOn || null,
      url: normalizeUrl(url),
    })
    .returning();
  revalidateAll();
  return row;
}

export async function updateApplication(
  id: number,
  patch: {
    company?: string;
    role?: string;
    appliedOn?: string | null;
    url?: string | null;
    notes?: string;
  },
): Promise<void> {
  const next: Partial<typeof applications.$inferInsert> = { updatedAt: new Date() };
  if (patch.company !== undefined) next.company = patch.company.trim();
  if (patch.role !== undefined) next.role = patch.role.trim();
  if (patch.appliedOn !== undefined) next.appliedOn = patch.appliedOn || null;
  if (patch.url !== undefined) next.url = normalizeUrl(patch.url);
  if (patch.notes !== undefined) next.notes = patch.notes;

  await getDb().update(applications).set(next).where(eq(applications.id, id));
  revalidateAll();
}

/** Docs go with it via ON DELETE CASCADE. */
export async function deleteApplication(id: number): Promise<void> {
  await getDb().delete(applications).where(eq(applications.id, id));
  revalidateAll();
}

export type DocUploadResult =
  | { ok: true; doc: ApplicationDocMeta }
  | { ok: false; error: string };

/**
 * Replaces any existing doc of the same kind. Delete-then-insert rather than
 * upsert on purpose: a fresh id per version is what makes the immutable
 * Cache-Control on /api/application-docs/[id] safe. neon-http has no
 * transactions, so a failure between the two statements loses the old doc —
 * acceptable here, since the user is holding the replacement in their hand.
 */
export async function uploadApplicationDoc(
  applicationId: number,
  kind: ApplicationDocKind,
  formData: FormData,
): Promise<DocUploadResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "No file received." };
  if (file.size > MAX_PDF_BYTES) {
    return { ok: false, error: `Keep it under ${PDF_LIMIT_LABEL}.` };
  }

  const buf = Buffer.from(await file.arrayBuffer());
  // Magic bytes, not just the MIME type — file.type is whatever the browser
  // guessed from the extension, and this route serves same-origin.
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, error: "That file isn't a PDF." };
  }

  const fallback = kind === "resume" ? "resume.pdf" : "cover-letter.pdf";
  const filename = (file.name || fallback).trim().slice(0, 200) || fallback;

  const db = getDb();
  await db
    .delete(applicationDocs)
    .where(
      sql`${applicationDocs.applicationId} = ${applicationId} and ${applicationDocs.kind} = ${kind}`,
    );
  const [row] = await db
    .insert(applicationDocs)
    .values({
      applicationId,
      kind,
      filename,
      data: buf.toString("base64"),
      byteSize: buf.byteLength,
    })
    .returning({
      id: applicationDocs.id,
      kind: applicationDocs.kind,
      filename: applicationDocs.filename,
      byteSize: applicationDocs.byteSize,
    });
  revalidateAll();
  return { ok: true, doc: row };
}

export async function removeApplicationDoc(docId: number): Promise<void> {
  await getDb().delete(applicationDocs).where(eq(applicationDocs.id, docId));
  revalidateAll();
}
