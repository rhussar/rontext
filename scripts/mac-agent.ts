/**
 * The Mac agent — what launchd runs nightly (see install-mac-agent.sh).
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/mac-agent.ts [--months N] [--dry-run]
 *
 * Does the one thing that can only happen on this machine: read Messages
 * (chat.db) and push counts to the app. Then writes a heartbeat row to
 * job_runs (job "messages", trigger "mac") so Settings → Accounts →
 * Automation shows it next to the Vercel jobs — including a red row with the
 * reason when it fails, and a visibly stale one when the Mac just hasn't run
 * it (asleep, agent unloaded, node upgraded and lost Full Disk Access).
 *
 * Self-contained on purpose: launchd gives us no shell, so this file loads
 * web/.env.local itself (only when DATABASE_URL isn't already in the env),
 * and the plist's program is `node` directly rather than `bash -c` — TCC
 * attributes Full Disk Access to the *program*, and you can grant it to node
 * but not sensibly to bash. Nothing here needs .env.local beyond DATABASE_URL.
 *
 * Apple Contacts push (push-apple-contact-names.ts) is deliberately NOT here:
 * it edits the address book and wants a human reading the diff first.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

function loadEnvLocal(): void {
  if (process.env.DATABASE_URL) return;
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function main() {
  loadEnvLocal();
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set and web/.env.local wasn't found — run from web/.");
    process.exit(2);
  }
  // Imported after the env is loaded: getDb() reads DATABASE_URL at first use.
  const [{ getDb }, { jobRuns }, reader] = await Promise.all([
    import("../src/db"),
    import("../src/db/schema"),
    import("./messages-reader"),
  ]);

  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const monthsArg = argv.indexOf("--months");
  const months =
    monthsArg >= 0 ? Math.max(parseInt(argv[monthsArg + 1] ?? "12", 10) || 12, 1) : 12;

  const startedAt = new Date();
  const host = hostname();
  let status: "ok" | "failed" = "ok";
  let message: string;
  let summary: Record<string, unknown> = { host, months, node: process.version };

  try {
    const s = await reader.syncMessages({ months, dryRun, log: console.log });
    if (!s.ok) throw new Error(s.error ?? "Messages sync failed");
    message =
      `${host} · last ${months} months · ${s.handles} handles · ${s.matched} people matched` +
      (s.enriched ? ` · ${s.enriched} enriched` : "") +
      (s.candidatesNew ? ` · ${s.candidatesNew} new to review` : "") +
      (dryRun ? " (dry run)" : "");
    summary = {
      ...summary,
      handles: s.handles,
      monthlyBuckets: s.monthlyBuckets,
      scanned: s.scanned,
      matched: s.matched,
      enriched: s.enriched,
      candidatesNew: s.candidatesNew,
      candidatesPending: s.candidatesPending,
      periods: s.periods,
      dryRun,
    };
  } catch (err) {
    status = "failed";
    message = reader.isFullDiskAccessError(err)
      ? `${host} · no Full Disk Access for ${process.execPath} — System Settings → Privacy & Security → Full Disk Access → add that node binary`
      : `${host} · ${err instanceof Error ? err.message.slice(0, 400) : String(err)}`;
  }

  console.log(`${status}: ${message}`);
  if (!dryRun) {
    await getDb().insert(jobRuns).values({
      job: "messages",
      status,
      trigger: "mac",
      startedAt,
      finishedAt: new Date(),
      message,
      summary,
    });
  }
  process.exit(status === "ok" ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
