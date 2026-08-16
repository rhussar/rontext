/**
 * Nightly JSON snapshot to Vercel Blob — the same document /api/export?format=json
 * serves, written to a *private* blob under backups/ and pruned after
 * RETENTION_DAYS. Neon's own point-in-time restore covers "the database
 * broke"; this covers "the database is fine but I want yesterday's copy of my
 * notes in a file I control".
 *
 * Needs BLOB_READ_WRITE_TOKEN (Vercel → Storage → Blob store, connected to
 * the project). It's passed to the SDK explicitly rather than left to the
 * implicit env read, so a value saved in Setup wins over a stale env var —
 * the same rule as ANTHROPIC_API_KEY. Unset → skipped, not failed.
 */
import { del, list, put } from "@vercel/blob";
import { getSecret } from "@/lib/secrets";
import { snapshotJson } from "@/lib/export";
import type { JobResult } from "./registry";

const PREFIX = "backups/";
const RETENTION_DAYS = 30;

export async function backupJob(): Promise<JobResult> {
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

  const kb = Math.round(body.length / 1024);
  return {
    status: "ok",
    message: `${kb.toLocaleString()} KB · ${snapshot.counts.contacts} contacts · ${existing.blobs.length - stale.length} snapshots kept`,
    summary: {
      pathname: blob.pathname,
      bytes: body.length,
      counts: snapshot.counts,
      pruned: stale.length,
      kept: existing.blobs.length - stale.length,
    },
  };
}
