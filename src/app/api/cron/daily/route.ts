/**
 * The one scheduled entry point. vercel.json points a single daily cron here
 * (one cron because the Hobby plan allows two, and one dispatcher that fans
 * out is also just simpler); the registry decides which jobs are actually due.
 *
 * Auth: Vercel sends `Authorization: Bearer <CRON_SECRET>` on every cron
 * invocation once that env var exists on the project. Env only, on purpose —
 * unlike the Setup-editable keys, this one authenticates the *scheduler*, and
 * a value that could be changed from inside the app would let the app grant
 * itself scheduling. Unset → 401 for everyone (fails closed), which is what
 * makes the proxy exemption for /api/cron safe.
 *
 * Query: ?job=<key> to run one job, ?force=1 to ignore intervals. Both are for
 * hand-testing with curl; the scheduler sends neither.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isJobKey, runDueJobs } from "@/lib/jobs/registry";

/**
 * Wall-clock ceiling for the whole dispatch. 300s is the Hobby maximum with
 * Fluid compute; the photo job is the only one that can approach it and it
 * stops itself at the deadline below with margin.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const DEADLINE_MARGIN_MS = 25_000;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const onlyRaw = req.nextUrl.searchParams.get("job");
  if (onlyRaw && !isJobKey(onlyRaw)) {
    return NextResponse.json({ error: `unknown job "${onlyRaw}"` }, { status: 400 });
  }
  const only = onlyRaw && isJobKey(onlyRaw) ? onlyRaw : undefined;
  const force = req.nextUrl.searchParams.get("force") === "1";
  const started = Date.now();
  const lines: string[] = [];

  const report = await runDueJobs({
    trigger: "cron",
    deadline: started + maxDuration * 1000 - DEADLINE_MARGIN_MS,
    only,
    force,
    log: (l) => lines.push(l),
  });

  return NextResponse.json({
    ok: true,
    tookMs: Date.now() - started,
    ran: report.ran.map((r) => ({
      job: r.job,
      status: r.status,
      message: r.message,
      ms: r.finishedAt.getTime() - r.startedAt.getTime(),
    })),
    notDue: report.notDue,
    outOfTime: report.outOfTime,
    log: lines,
  });
}
