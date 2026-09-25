/**
 * The Mac agent — what launchd runs (see install-mac-agent.sh).
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/mac-agent.ts \
 *     [--only messages,whatsapp,contacts] [--months N] [--dry-run]
 *
 * Does the things that can only happen on this machine: read Messages
 * (chat.db) and WhatsApp for Mac's ChatStorage.sqlite and push counts to the
 * app, and fold newly added Apple contacts into the book. Each writes its own
 * heartbeat row to job_runs (job "messages" / "whatsapp" / "apple-contacts",
 * trigger "mac") so Settings → Accounts → Automation shows
 * them next to the Vercel jobs — including a red row with the reason when one
 * fails, and a visibly stale one when the Mac just hasn't run it (asleep,
 * agent unloaded, node upgraded and lost Full Disk Access).
 *
 * They run on separate launchd schedules — contacts hourly, because a number
 * saved on the phone should land within the hour; Messages and WhatsApp daily,
 * because each is a full re-scan and nothing about it is urgent. Hence --only,
 * which takes a comma list. WhatsApp writes a "skipped" heartbeat rather than
 * a red one on a Mac where WhatsApp for Mac isn't installed.
 *
 * Self-contained on purpose: launchd gives us no shell, so this file loads
 * web/.env.local itself (only when DATABASE_URL isn't already in the env),
 * and the plist's program is `node` directly rather than `bash -c` — TCC
 * attributes Full Disk Access to the *program*, and you can grant it to node
 * but not sensibly to bash. Nothing here needs .env.local beyond DATABASE_URL.
 *
 * Apple Contacts *push* (push-apple-contact-names.ts) is still deliberately
 * NOT here: it edits the address book and wants a human reading the diff
 * first. The contacts pass below only ever reads.
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
  const [{ getDb }, { jobRuns }, reader, whatsapp, appleContacts] = await Promise.all([
    import("../src/db"),
    import("../src/db/schema"),
    import("./messages-reader"),
    import("./whatsapp-reader"),
    import("./apple-contacts-sync"),
  ]);

  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyArg = argv.indexOf("--only");
  const PARTS = ["messages", "whatsapp", "contacts"] as const;
  type Part = (typeof PARTS)[number];
  const only: Part[] =
    onlyArg >= 0 ? ((argv[onlyArg + 1] ?? "").split(",").filter(Boolean) as Part[]) : [...PARTS];
  const unknown = only.filter((p) => !PARTS.includes(p));
  if (!only.length || unknown.length) {
    console.error(`--only takes a comma list of ${PARTS.join(", ")}, got ${JSON.stringify(argv[onlyArg + 1])}`);
    process.exit(2);
  }
  const monthsArg = argv.indexOf("--months");
  const months =
    monthsArg >= 0 ? Math.max(parseInt(argv[monthsArg + 1] ?? "12", 10) || 12, 1) : 12;

  const host = hostname();

  /**
   * One pass, one heartbeat. The heartbeat is written for a failure too —
   * silence in the Automation panel is indistinguishable from a Mac that's
   * been asleep, and that ambiguity is the whole reason job_runs exists.
   */
  async function heartbeat(
    job: "messages" | "whatsapp" | "apple-contacts",
    startedAt: Date,
    status: "ok" | "failed" | "skipped",
    message: string,
    summary: Record<string, unknown>,
  ): Promise<void> {
    console.log(`${job}: ${status}: ${message}`);
    if (dryRun) return;
    await getDb().insert(jobRuns).values({
      job,
      status,
      trigger: "mac",
      startedAt,
      finishedAt: new Date(),
      message,
      summary,
    });
  }

  async function runContacts(): Promise<boolean> {
    const startedAt = new Date();
    try {
      const s = await appleContacts.syncAppleContacts({ dryRun, log: console.log });
      await heartbeat(
        "apple-contacts",
        startedAt,
        "ok",
        `${host} · ${appleContacts.describe(s)}${dryRun ? " (dry run)" : ""}`,
        { host, node: process.version, ...s, dryRun },
      );
      return true;
    } catch (err) {
      await heartbeat(
        "apple-contacts",
        startedAt,
        "failed",
        appleContacts.isFullDiskAccessError(err)
          ? `${host} · ${appleContacts.FULL_DISK_ACCESS_HINT} (${process.execPath})`
          : `${host} · ${err instanceof Error ? err.message.slice(0, 400) : String(err)}`,
        { host, node: process.version, dryRun },
      );
      return false;
    }
  }

  async function runMessages(): Promise<boolean> {
  const startedAt = new Date();
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
    // Who-knows-whom from small group chats. Its own try: a problem here
    // must not turn a successful 1:1 sync into a red row.
    try {
      const g = await reader.syncGroupChatLinks({ dryRun, log: console.log });
      message += ` · ${g.pairs} group-chat links`;
      summary = { ...summary, groupChatPairs: g.pairs, groupChatThreads: g.usableThreads };
    } catch (err) {
      console.error("group chat links failed:", err);
      summary = { ...summary, groupChatError: err instanceof Error ? err.message.slice(0, 200) : String(err) };
    }

  } catch (err) {
    status = "failed";
    message = reader.isFullDiskAccessError(err)
      ? `${host} · no Full Disk Access for ${process.execPath} — System Settings → Privacy & Security → Full Disk Access → add that node binary`
      : `${host} · ${err instanceof Error ? err.message.slice(0, 400) : String(err)}`;
  }

  await heartbeat("messages", startedAt, status, message, summary);
  return status === "ok";
  }

  async function runWhatsApp(): Promise<boolean> {
    const startedAt = new Date();
    const base = { host, months, node: process.version, dryRun };
    if (!whatsapp.whatsappInstalled()) {
      await heartbeat("whatsapp", startedAt, "skipped", `${host} · ${whatsapp.NOT_INSTALLED_HINT}`, base);
      return true;
    }
    try {
      const { messages: s, groups: g } = await whatsapp.syncWhatsApp({ months, dryRun, log: console.log });
      if (!s.ok) throw new Error(s.error ?? "WhatsApp sync failed");
      const message =
        `${host} · last ${months} months · ${s.handles} chats · ${s.matched} people matched` +
        (s.enriched ? ` · ${s.enriched} enriched` : "") +
        (s.candidatesNew ? ` · ${s.candidatesNew} new to review` : "") +
        ("error" in g ? "" : ` · ${g.pairs} group-chat links`) +
        (dryRun ? " (dry run)" : "");
      await heartbeat("whatsapp", startedAt, "ok", message, {
        ...base,
        handles: s.handles,
        monthlyBuckets: s.monthlyBuckets,
        scanned: s.scanned,
        matched: s.matched,
        enriched: s.enriched,
        candidatesNew: s.candidatesNew,
        candidatesPending: s.candidatesPending,
        periods: s.periods,
        ...("error" in g
          ? { groupChatError: g.error }
          : { groupChatPairs: g.pairs, groupChatThreads: g.usableThreads }),
      });
      return true;
    } catch (err) {
      await heartbeat(
        "whatsapp",
        startedAt,
        "failed",
        reader.isFullDiskAccessError(err)
          ? `${host} · no Full Disk Access for ${process.execPath} — System Settings → Privacy & Security → Full Disk Access → add that node binary`
          : `${host} · ${err instanceof Error ? err.message.slice(0, 400) : String(err)}`,
        base,
      );
      return false;
    }
  }

  // Contacts first: it is the fast one, and a slow Messages scan shouldn't
  // delay a number that was saved an hour ago.
  let ok = true;
  if (only.includes("contacts")) ok = (await runContacts()) && ok;
  if (only.includes("messages")) ok = (await runMessages()) && ok;
  if (only.includes("whatsapp")) ok = (await runWhatsApp()) && ok;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
