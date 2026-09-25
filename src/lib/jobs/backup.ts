/**
 * Nightly JSON snapshot to Vercel Blob — the same document /api/export?format=json
 * serves, written to a *private* blob under backups/ and pruned after
 * RETENTION_DAYS. Neon's own point-in-time restore covers "the database
 * broke"; this covers "the database is fine but I want yesterday's copy of my
 * notes in a file I control".
 *
 * PDFs (attached to people and to applications) exist nowhere else, so they're
 * backed up too — but as files, not inside the snapshot, and each one exactly
 * once: 30 daily snapshots each carrying every PDF would be 30 copies. Both
 * tables are insert-only (a replace is a new row), so a row id names fixed
 * bytes forever. A small "last seen" index in app_state tracks which ids are
 * uploaded and when a snapshot last referenced them; a file is deleted only
 * once RETENTION_DAYS have passed since the last snapshot that listed it — the
 * same horizon as the snapshots themselves, so every kept snapshot's `file`
 * paths still resolve.
 *
 * Needs BLOB_READ_WRITE_TOKEN (Vercel → Storage → Blob store, connected to
 * the project). It's passed to the SDK explicitly rather than left to the
 * implicit env read, so a value saved in Setup wins over a stale env var —
 * the same rule as every Setup key. Unset → skipped, not failed.
 */
import { del, list, put } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appState, applicationDocs, contactDocs } from "@/db/schema";
import { getSecret } from "@/lib/secrets";
import { backupFilePath, snapshotJson, type BackupFileKind } from "@/lib/export";
import type { JobContext, JobResult } from "./registry";

const PREFIX = "backups/";
const RETENTION_DAYS = 30;
/** app_state key for the file index: `${kind}/${id}` → ISO date last referenced. */
const FILES_STATE_KEY = "backupFilesSeen";
/** Stop starting uploads this close to the deadline; one PDF is at most a few MB. */
const DEADLINE_MARGIN_MS = 15_000;

export async function backupJob(ctx: JobContext): Promise<JobResult> {
  const token = await getSecret("BLOB_READ_WRITE_TOKEN");
  if (!token) {
    return {
      status: "skipped",
      message: "BLOB_READ_WRITE_TOKEN not set — connect a Blob store to enable backups",
    };
  }

  const snapshot = await snapshotJson();
  const body = JSON.stringify(snapshot);
  const stamp = snapshot.exportedAt.replace(/[:.]/g, "-");
  const pathname = `${PREFIX}rontext-${stamp}.json`;

  const blob = await put(pathname, body, {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    token,
  });

  // Prune. Listing is paginated but backups/ holds ~30 files, so one page.
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const existing = await list({ prefix: PREFIX, token, limit: 1000 });
  const stale = existing.blobs.filter(
    (b) => b.pathname !== pathname && new Date(b.uploadedAt).getTime() < cutoff,
  );
  if (stale.length) await del(stale.map((b) => b.url), { token });

  // After the snapshot on purpose: the snapshot is the part that matters most,
  // and file uploads are the part that can run out of time. What doesn't fit
  // today is picked up tomorrow — the index only records finished uploads.
  const files = await backupFiles(token, ctx.deadline - DEADLINE_MARGIN_MS, cutoff);

  const kb = Math.round(body.length / 1024);
  const pdfs =
    files.pending > 0
      ? ` · ${files.uploaded} PDFs backed up, ${files.pending} left for next run`
      : files.uploaded > 0
        ? ` · ${files.uploaded} new PDFs backed up`
        : "";
  return {
    status: "ok",
    message: `${kb.toLocaleString()} KB · ${snapshot.counts.contacts} contacts · ${existing.blobs.length - stale.length} snapshots kept${pdfs}`,
    summary: {
      pathname: blob.pathname,
      bytes: body.length,
      counts: snapshot.counts,
      pruned: stale.length,
      kept: existing.blobs.length - stale.length,
      files,
    },
  };
}

async function backupFiles(
  token: string,
  deadline: number,
  cutoff: number,
): Promise<{ uploaded: number; pending: number; pruned: number; kept: number }> {
  const db = getDb();
  const [contactIds, applicationIds, [state]] = await Promise.all([
    db.select({ id: contactDocs.id }).from(contactDocs),
    db.select({ id: applicationDocs.id }).from(applicationDocs),
    db.select({ value: appState.value }).from(appState).where(eq(appState.key, FILES_STATE_KEY)),
  ]);

  let seen: Record<string, string> = {};
  try {
    seen = state ? (JSON.parse(state.value) as Record<string, string>) : {};
  } catch {
    // A corrupt index only costs re-uploads (put overwrites), never data.
  }

  const now = new Date().toISOString();
  const current: { kind: BackupFileKind; id: number }[] = [
    ...contactIds.map((r) => ({ kind: "contact-docs" as const, id: r.id })),
    ...applicationIds.map((r) => ({ kind: "application-docs" as const, id: r.id })),
  ];
  const missing: typeof current = [];
  for (const f of current) {
    const key = `${f.kind}/${f.id}`;
    if (seen[key]) seen[key] = now;
    else missing.push(f);
  }

  // One PDF's bytes at a time — never the whole table in memory.
  let uploaded = 0;
  for (const f of missing) {
    if (Date.now() > deadline) break;
    const table = f.kind === "contact-docs" ? contactDocs : applicationDocs;
    const [row] = await db.select({ data: table.data }).from(table).where(eq(table.id, f.id));
    if (!row) continue; // deleted since the id list was read
    await put(backupFilePath(f.kind, f.id), Buffer.from(row.data, "base64"), {
      access: "private",
      contentType: "application/pdf",
      addRandomSuffix: false,
      allowOverwrite: true,
      token,
    });
    seen[`${f.kind}/${f.id}`] = now;
    uploaded++;
  }

  // A file outlives its row by RETENTION_DAYS, so restoring any kept snapshot
  // still finds the PDFs it lists.
  const expired = Object.entries(seen)
    .filter(([, lastSeen]) => Date.parse(lastSeen) < cutoff)
    .map(([key]) => key);
  if (expired.length) {
    await del(
      expired.map((key) => {
        const [kind, id] = key.split("/");
        return backupFilePath(kind as BackupFileKind, Number(id));
      }),
      { token },
    );
    for (const key of expired) delete seen[key];
  }

  const value = JSON.stringify(seen);
  await db
    .insert(appState)
    .values({ key: FILES_STATE_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt: new Date() } });

  return {
    uploaded,
    pending: missing.length - uploaded,
    pruned: expired.length,
    kept: Object.keys(seen).length,
  };
}
