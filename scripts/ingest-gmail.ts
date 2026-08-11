/**
 * Gmail ingest, run from the command line (from web/):
 *
 *   Preview without writing anything:
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-gmail.ts --dry-run
 *
 *   For real, default 12-month window:
 *     set -a && source .env.local && set +a && npx tsx scripts/ingest-gmail.ts
 *
 *   Options: --months 24   --max 5000
 *
 * Pair first with `npx tsx scripts/pair-gmail.ts`. The refresh token stays in
 * ~/.mesh-replica/gmail.json on this Mac — nothing is stored in the database.
 *
 * **Metadata only.** Every fetch uses format=metadata with an explicit header
 * allowlist, so no subject line and no message body is ever requested, let
 * alone stored. That's enforced by the request shape, not by discipline.
 *
 * Undo with: npx tsx scripts/revert-connector.ts --connector gmail
 */
import { getAccessToken, gmailGet, loadCredentials } from "./gmail-auth";
import { ingestHandles, type HandleAggregate } from "../src/lib/connector-ingest";

/** Headers we ask for. Deliberately no Subject. */
const HEADERS = ["From", "To", "Cc", "List-Unsubscribe"];

/**
 * Addresses that are machinery, not people. These slip past the two-way test
 * whenever you've ever replied to a ticket robot.
 */
const JUNK_LOCAL =
  /^(no-?reply|do-?not-?reply|notifications?|mailer|bounce|postmaster|support|billing|invoices?|receipts?|automated|alerts?|updates?|news|info|hello|team|admin)([+.-]|$)/i;

type MessageMeta = {
  id: string;
  internalDate: string;
  payload?: { headers?: { name: string; value: string }[] };
};

/** "Jane Doe <jane@x.com>, bob@y.com" → [{name, email}] */
function parseAddresses(raw: string): { name: string | null; email: string }[] {
  const out: { name: string | null; email: string }[] = [];
  // Split on commas that aren't inside a quoted display name.
  for (const part of raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const chunk = part.trim();
    if (!chunk) continue;
    const angled = chunk.match(/^(.*?)<([^>]+)>$/);
    const email = (angled ? angled[2] : chunk).trim().toLowerCase();
    if (!email.includes("@")) continue;
    let name = angled ? angled[1].trim().replace(/^"|"$/g, "").trim() : "";
    // Gmail writes the address itself as the display name when there isn't one.
    if (name.toLowerCase() === email) name = "";
    out.push({ name: name || null, email });
  }
  return out;
}

function header(msg: MessageMeta, name: string): string | null {
  const hit = msg.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return hit?.value ?? null;
}

/** Run `jobs` with bounded concurrency — Gmail rate-limits hard above ~10. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function listIds(
  token: string,
  q: string,
  max: number,
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmailGet<{
      messages?: { id: string }[];
      nextPageToken?: string;
    }>(token, "messages", {
      q,
      maxResults: "500",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);

  return { ids: ids.slice(0, max), truncated: ids.length > max };
}

async function fetchMeta(token: string, ids: string[]): Promise<MessageMeta[]> {
  const rows = await pooled(ids, 10, (id) =>
    gmailGet<MessageMeta>(token, `messages/${id}`, {
      format: "metadata",
      metadataHeaders: HEADERS,
    }).catch(() => null),
  );
  return rows.filter((r): r is MessageMeta => r !== null);
}

type Tally = {
  handle: string;
  displayName: string | null;
  sentCount: number;
  receivedCount: number;
  first: number;
  last: number;
};

function record(
  tallies: Map<string, Tally>,
  addr: { name: string | null; email: string },
  direction: "sent" | "received",
  ts: number,
) {
  const t = tallies.get(addr.email) ?? {
    handle: addr.email,
    displayName: null,
    sentCount: 0,
    receivedCount: 0,
    first: ts,
    last: ts,
  };
  if (direction === "sent") t.sentCount++;
  else t.receivedCount++;
  if (!t.displayName && addr.name) t.displayName = addr.name;
  if (ts < t.first) t.first = ts;
  if (ts > t.last) t.last = ts;
  tallies.set(addr.email, t);
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const num = (flag: string, dflt: number) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Math.max(parseInt(argv[i + 1] ?? "", 10) || dflt, 1) : dflt;
  };
  const months = num("--months", 12);
  const max = num("--max", 5000);

  const creds = loadCredentials();
  if (!creds) {
    console.error("Not paired yet. Run: npx tsx scripts/pair-gmail.ts");
    process.exit(1);
  }
  const token = await getAccessToken(creds);
  const me = (creds.emailAddress ?? "").toLowerCase();
  console.log(`Reading ${me || "mailbox"} — last ${months} months, metadata only.`);

  const tallies = new Map<string, Tally>();
  let truncatedAny = false;

  // Pass 1: what you sent. People you email are people you know, and this is a
  // fraction of the volume of a whole mailbox.
  const sent = await listIds(token, `in:sent newer_than:${months}m`, max);
  truncatedAny ||= sent.truncated;
  console.log(`  ${sent.ids.length} sent messages`);
  for (const msg of await fetchMeta(token, sent.ids)) {
    const ts = Number(msg.internalDate);
    for (const field of ["To", "Cc"]) {
      const raw = header(msg, field);
      if (!raw) continue;
      for (const addr of parseAddresses(raw)) {
        if (addr.email === me) continue;
        record(tallies, addr, "sent", ts);
      }
    }
  }

  // Pass 2: what came back. Category filters strip promotions and social before
  // they can become candidates.
  const inbox = await listIds(
    token,
    `in:inbox newer_than:${months}m -category:promotions -category:social -category:updates -category:forums`,
    max,
  );
  truncatedAny ||= inbox.truncated;
  console.log(`  ${inbox.ids.length} inbox messages`);
  for (const msg of await fetchMeta(token, inbox.ids)) {
    // A List-Unsubscribe header means a mailing list, however personal it looks.
    if (header(msg, "List-Unsubscribe")) continue;
    const from = header(msg, "From");
    if (!from) continue;
    const ts = Number(msg.internalDate);
    for (const addr of parseAddresses(from)) {
      if (addr.email === me) continue;
      record(tallies, addr, "received", ts);
    }
  }

  if (truncatedAny) {
    console.log(
      `  NOTE: hit the --max ${max} cap on at least one pass — older mail in ` +
        `the window was not read. Re-run with a larger --max to cover it.`,
    );
  }

  const rows: HandleAggregate[] = [];
  let junk = 0;
  for (const t of tallies.values()) {
    const local = t.handle.split("@")[0];
    if (JUNK_LOCAL.test(local)) {
      junk++;
      continue;
    }
    rows.push({
      handle: t.handle,
      displayName: t.displayName,
      messageCount: t.sentCount + t.receivedCount,
      sentCount: t.sentCount,
      receivedCount: t.receivedCount,
      firstAt: iso(t.first),
      lastAt: iso(t.last),
    });
  }
  console.log(
    `  ${tallies.size} addresses seen, ${junk} filtered as automated, ${rows.length} kept`,
  );

  const summary = await ingestHandles("gmail", "email", rows, { dryRun });
  const { details, ...counts } = summary;
  console.log(JSON.stringify(counts, null, 2));

  if (details.length) {
    console.log(`\n${dryRun ? "Would change" : "Changed"}:`);
    for (const d of details.slice(0, 40)) {
      console.log(`  ${d.contact ?? d.handle} — ${d.note}`);
    }
    if (details.length > 40) console.log(`  … and ${details.length - 40} more`);
  }
  if (dryRun) console.log("\nDry run — nothing was written.");
  if (!summary.ok) process.exit(1);
}

main();
