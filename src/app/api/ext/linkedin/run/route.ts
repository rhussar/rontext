/**
 * POST /api/ext/linkedin/run — the extension's report at the end of a day's
 * visit batch (or when it gave up: auth wall, Chrome closed). Lands in
 * job_runs as job "linkedin" / trigger "extension", so the Automation panel
 * shows the LinkedIn visits row next to everything else.
 */
import { z } from "zod";
import { getDb } from "@/db";
import { jobRuns } from "@/db/schema";
import { extAuthorized, extJson, extOptions, extUnauthorized, stampExtensionSeen } from "@/lib/ext-auth";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  status: z.enum(["ok", "failed", "skipped"]),
  message: z.string().max(500),
  startedAt: z.string().datetime({ offset: true }).optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
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
  if (!parsed.success) return extJson({ error: "invalid body" }, { status: 400 });
  const b = parsed.data;
  const startedAt = b.startedAt ? new Date(b.startedAt) : new Date();
  await getDb().insert(jobRuns).values({
    job: "linkedin",
    status: b.status,
    trigger: "extension",
    startedAt,
    finishedAt: new Date(),
    message: b.message,
    summary: b.summary ?? null,
  });
  await stampExtensionSeen(req);
  return extJson({ ok: true });
}
