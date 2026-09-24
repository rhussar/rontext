/**
 * Daily refresh of the find_people index (memory_chunks).
 *
 * The MCP tool already refreshes on demand when the index is stale, so this
 * job is the backstop: it keeps vectors current for the notes and meetings
 * that arrive between searches, and it's where a bad Voyage key shows up red
 * in Automation instead of as quietly worse search results.
 *
 * No VOYAGE_API_KEY is an `ok` run, not `skipped`: the keyword half of the
 * index still synced, which is real work. The message says keyword-only.
 */
import { refreshMemory } from "@/lib/memory/sync";
import { JobFailure, type JobContext, type JobResult } from "./registry";

export async function memoryJob(ctx: JobContext): Promise<JobResult> {
  const r = await refreshMemory(ctx.deadline);
  const summary = { ...r };
  const delta = r.inserted + r.changed + r.deleted;
  const head = `${r.chunks.toLocaleString()} chunks, ${delta} changed`;

  if (r.error) {
    throw new JobFailure(`${head} — embedding stopped: ${r.error}`, summary);
  }
  if (!r.configured) {
    return {
      status: "ok",
      message: `${head} · keyword-only (VOYAGE_API_KEY not set)`,
      summary,
    };
  }
  return {
    status: "ok",
    message:
      `${head} · ${r.embedded} embedded` + (r.pending ? ` · ${r.pending} left for next run` : ""),
    summary,
  };
}
