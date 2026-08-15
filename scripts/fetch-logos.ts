/**
 * Fetch and cache company logos:
 *   set -a && source .env.local && set +a && npx tsx scripts/fetch-logos.ts [flags]
 *
 * Flags:
 *   --source ddg|unavatar  Image source. Default ddg (free). unavatar costs
 *                          money and needs UNAVATAR_API_KEY.
 *   --guess                Derive a domain from the company NAME for hubs that
 *                          have none on file. Off by default — a guess that
 *                          lands on the wrong company shows the wrong logo.
 *   --max-cost N           unavatar only. Stop once spend reaches $N. Default
 *                          $2, hard ceiling $15 — a larger value is refused,
 *                          not clamped silently.
 *   --limit N              Only process the first N targets.
 *   --dry-run              Print the resolved domain per company, fetch nothing.
 *   --force                Re-fetch even entities that already have a logo.
 *
 * Runs locally, not on Vercel: it's a one-off backfill, and keeping `sharp`
 * out of the serverless bundle avoids a native-binary deploy problem for no
 * benefit. Only company domains leave the machine, and only once — after this
 * the browser reads logos from our own /api/logos route.
 *
 * On the two sources, measured side by side on the same 12 domains: DDG and
 * unavatar both hit 11/12, but 5 of unavatar's came back image/svg+xml, which
 * the raster-only rule below rejects outright — and DDG's ICOs are larger,
 * carrying the 256px frames `toPng` mines. DDG is free and generally the
 * better disc; unavatar is kept as an option because it aggregates sources DDG
 * sometimes misses.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import decodeIco from "decode-ico";
import sharp from "sharp";
import { getDb } from "../src/db";
import { contactEntities, contacts, entities, entityLogos } from "../src/db/schema";
import { MIN_HUB_SIZE } from "../src/lib/graph/query";
import { getSecret } from "../src/lib/secrets";

/**
 * Texture resolution follows the cached image (@sigma/node-image sizes its
 * atlas from the source), so this IS the on-screen ceiling. 256 keeps discs
 * crisp on retina and under zoom — many brand ICOs ship a 256px frame, and
 * the decoder already picks the largest, so this stops throwing it away.
 */
const SIZE = 256;
const CONCURRENCY = 6;

/** $0.010 per token, per unavatar's PRO pricing (same rate as backfill-photos). */
const PRICE_PER_TOKEN = 0.01;
/**
 * Absolute ceiling on unavatar spend, in dollars. Not overridable — the point
 * of a spend cap is that a typo in a flag can't raise it.
 */
const HARD_CAP_USD = 15;

type Row = { id: number; name: string; domain: string };

/**
 * Legal suffixes and decorations that never appear in a domain. Ordered
 * longest-first so "Inc." doesn't strip out of "…Incorporated" mid-word.
 */
const NAME_NOISE =
  /\s*(?:,?\s*(?:incorporated|corporation|company|limited|holdings|group|partners|llp|llc|ltd|inc|corp|co|plc|lp|sa|ag|nv|bv|gmbh|pty|pllc)\b\.?)+\s*$/gi;

/**
 * Names that carry no company identity at all — guessing a domain for these
 * would be pure fabrication, so they're skipped rather than mis-resolved.
 */
const UNGUESSABLE = /^(self[\s-]?employed|freelance|retired|student|unemployed|various|independent|n\/?a)$/i;

/**
 * Company name → best-guess domain. Deliberately conservative: it strips the
 * decorations a domain never has (legal suffixes, parentheticals, trademark
 * marks, accents) and refuses anything too short or too generic to be a real
 * guess. It is still a GUESS — see --guess in the header.
 */
export function guessDomain(name: string): string | null {
  let s = name
    .replace(/[™®©]/g, "")
    .replace(/\([^)]*\)/g, " ") // "(NYSE: PEB)", "(Sponsors for …)"
    .replace(/\s*&\s*/g, " ")
    .trim();
  s = s.replace(NAME_NOISE, "").trim();
  // Brands drop the article in their domain: "The TJX Companies" → tjx.com,
  // never thetjxcompanies.com.
  s = s.replace(/^the\s+/i, "").trim();
  if (!s || UNGUESSABLE.test(s)) return null;

  // Strip accents so "L'Oréal" → "loreal", matching how brands register.
  const slug = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  // Two characters isn't a guess, it's a coin flip; and a 40-char run-on name
  // is never the registered domain either.
  if (slug.length < 3 || slug.length > 30) return null;
  return `${slug}.com`;
}

/**
 * Consumer mail hosts — a contact's gmail address says nothing about where
 * they work, so these can never stand in for an employer domain.
 */
const FREE_MAIL = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "me.com", "msn.com", "live.com", "comcast.net", "verizon.net", "att.net",
  "sbcglobal.net", "protonmail.com", "proton.me", "mac.com", "ymail.com",
]);

/**
 * Domains recovered from the email addresses of people who actually work
 * there — evidence, not inference, so it outranks a name guess.
 *
 * Requires TWO contacts to agree. One is not evidence: plenty of people list a
 * personal .edu from school days, which is how a single address turns
 * "William Blair" into trincoll.edu and "PNC" into syr.edu.
 */
async function employerDomains(db: ReturnType<typeof getDb>): Promise<Map<number, string>> {
  const links = await db
    .select({ entityId: contactEntities.entityId, emails: contacts.emails })
    .from(contactEntities)
    .innerJoin(contacts, eq(contacts.id, contactEntities.contactId))
    .where(eq(contactEntities.role, "employee"));

  const tally = new Map<number, Map<string, number>>();
  for (const l of links) {
    for (const em of l.emails ?? []) {
      const host = em.split("@")[1]?.toLowerCase().trim();
      if (!host || FREE_MAIL.has(host) || !host.includes(".")) continue;
      let m = tally.get(l.entityId);
      if (!m) tally.set(l.entityId, (m = new Map()));
      m.set(host, (m.get(host) ?? 0) + 1);
    }
  }

  const out = new Map<number, string>();
  for (const [entityId, hosts] of tally) {
    const [best] = [...hosts.entries()].sort((a, b) => b[1] - a[1]);
    if (best && best[1] >= 2) out.set(entityId, best[0]);
  }
  return out;
}

type Fetched = { png: Buffer | null; tokens: number; note?: string };

async function fetchFromDdg(domain: string): Promise<Fetched> {
  const url = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    return { png: null, tokens: 0 };
  }
  // DDG answers 404 with a generic letter-tile placeholder — that's worse than
  // our own lettermark fallback, so treat it as "no logo" rather than cache it.
  if (!res.ok) return { png: null, tokens: 0 };

  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.byteLength === 0) return { png: null, tokens: 0 };

  try {
    return { png: await toPng(raw), tokens: 0 };
  } catch {
    return { png: null, tokens: 0 }; // unparseable icon — fall back to the circle
  }
}

/**
 * unavatar, keyed on a domain. `fallback=false` matters: without it a miss
 * comes back HTTP 200 carrying unavatar's own placeholder, which we would
 * happily cache as if it were the brand's mark.
 *
 * SVG is rejected here for the same reason it is in the photo pipeline: these
 * bytes get served back from our own origin by /api/logos/[entityId], and an
 * SVG can carry script. Roughly half of unavatar's company hits are SVG, so
 * this rejects a lot — that is the intended trade, not a bug.
 */
async function fetchFromUnavatar(domain: string, apiKey: string): Promise<Fetched> {
  let res: Response;
  try {
    res = await fetch(`https://unavatar.io/${domain}?fallback=false`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { png: null, tokens: 0 };
  }
  // Charged whether or not it resolves, so read the cost before any early exit.
  const tokens = Number(res.headers.get("x-unavatar-cost") ?? 0) || 0;
  if (res.status === 401 || res.status === 403) {
    throw new Error(`unavatar rejected the API key (HTTP ${res.status})`);
  }
  if (!res.ok) return { png: null, tokens };

  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type === "image/svg+xml") return { png: null, tokens, note: "svg rejected" };

  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.byteLength === 0) return { png: null, tokens };

  try {
    return { png: await toPng(raw), tokens };
  } catch {
    return { png: null, tokens, note: "undecodable" };
  }
}

/**
 * DuckDuckGo answers with either PNG or ICO depending on the site, and **sharp
 * cannot decode ICO** — libvips has no reader for it. Silently, that loses
 * exactly the recognizable brands (Deloitte, PwC, Goldman, SpaceX all serve
 * ICO), so decode those to raw RGBA first and hand sharp the pixels.
 *
 * An ICO holds several resolutions; take the largest, since we're downscaling.
 */
async function toPng(raw: Buffer): Promise<Buffer> {
  const isIco = raw.length > 4 && raw[0] === 0x00 && raw[1] === 0x00 && raw[2] === 0x01 && raw[3] === 0x00;

  const pipeline = isIco
    ? await (async () => {
        const images = decodeIco(raw);
        if (!images.length) throw new Error("empty ico");
        const best = images.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
        // decode-ico yields PNG-in-ICO entries verbatim; those sharp can read.
        return best.type === "png"
          ? sharp(Buffer.from(best.data))
          : sharp(Buffer.from(best.data), {
              raw: { width: best.width, height: best.height, channels: 4 },
            });
      })()
    : sharp(raw);

  /**
   * Full-bleed disc treatment (the board-graph look): flatten transparency
   * onto white and cover-fill the square, so the circle crop on the canvas
   * yields a solid disc — either the favicon's own tile colour, or a clean
   * white disc with the mark large in the middle. The old `fit: inside` +
   * transparency kept the marks small and floating, which read as "meshed".
   * Favicons are square in practice, so cover rarely crops anything real.
   */
  return pipeline
    .flatten({ background: "#ffffff" })
    .resize(SIZE, SIZE, { fit: "cover", withoutEnlargement: false })
    .png()
    .toBuffer();
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };

  const source = valueOf("--source") ?? "ddg";
  if (source !== "ddg" && source !== "unavatar") {
    throw new Error(`--source must be "ddg" or "unavatar", got "${source}"`);
  }

  const maxCostRaw = valueOf("--max-cost");
  const maxCost = maxCostRaw === null ? 2 : Number(maxCostRaw);
  if (!Number.isFinite(maxCost) || maxCost <= 0) {
    throw new Error(`--max-cost must be a positive number, got "${maxCostRaw}"`);
  }
  if (maxCost > HARD_CAP_USD) {
    throw new Error(
      `--max-cost ${maxCost} exceeds the hard cap of $${HARD_CAP_USD}. ` +
        `Raise HARD_CAP_USD in this file if that is genuinely intended.`,
    );
  }

  const limitRaw = valueOf("--limit");
  return {
    source: source as "ddg" | "unavatar",
    guess: args.includes("--guess"),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    limit: limitRaw ? Number(limitRaw) : null,
    maxCost,
  };
}

async function main() {
  const opts = parseArgs();
  const db = getDb();

  // Company-scoped: the graph draws companies only, and a guessed domain makes
  // no sense for a place or a group anyway (places get lettermarks from
  // seed-place-icons.ts).
  const rows = await db
    .select({
      id: entities.id,
      name: entities.name,
      domain: sql<string>`${entities.metadata}->>'domain'`,
      memberCount: entities.memberCount,
    })
    .from(entities)
    .where(and(eq(entities.type, "company"), gte(entities.memberCount, MIN_HUB_SIZE)));

  const existing = await db.select({ entityId: entityLogos.entityId }).from(entityLogos);
  const have = new Set(existing.map((e) => e.entityId));

  /**
   * Resolve each company to a domain, best evidence first:
   *   1. the domain the enrichment pass already recorded
   *   2. a domain two or more employees actually use in their email
   *   3. (--guess only) an inference from the company name
   * `origin` is carried through so the dry run and the log show you which
   * logos rest on evidence and which rest on a guess.
   */
  const fromEmail = await employerDomains(db);
  let guessed = 0;
  let unguessable = 0;
  const resolved = rows
    .map((r) => {
      if (r.domain) return { ...r, domain: r.domain, origin: "on file" as const };
      const evidence = fromEmail.get(r.id);
      if (evidence) return { ...r, domain: evidence, origin: "email" as const };
      if (!opts.guess) return null;
      const g = guessDomain(r.name);
      if (!g) {
        unguessable++;
        return null;
      }
      guessed++;
      return { ...r, domain: g, origin: "GUESS" as const };
    })
    .filter(Boolean) as (Row & {
    memberCount: number;
    origin: "on file" | "email" | "GUESS";
  })[];

  let todo = opts.force ? resolved : resolved.filter((t) => !have.has(t.id));
  todo.sort((a, b) => b.memberCount - a.memberCount); // biggest hubs first
  if (opts.limit) todo = todo.slice(0, opts.limit);

  console.log(`company hubs (>=${MIN_HUB_SIZE} members): ${rows.length}`);
  console.log(`  already cached:        ${rows.filter((r) => have.has(r.id)).length}`);
  console.log(`  domain on file:        ${resolved.filter((r) => r.origin === "on file").length}`);
  console.log(`  domain from email:     ${resolved.filter((r) => r.origin === "email").length}`);
  if (opts.guess) {
    console.log(`  domain guessed:        ${guessed}`);
    console.log(`  no guessable domain:   ${unguessable}`);
  }
  console.log(`  source:                ${opts.source}`);
  console.log(`  fetching:              ${todo.length}\n`);

  if (opts.dryRun) {
    for (const r of todo) {
      console.log(
        `  ${String(r.memberCount).padStart(3)}  ${r.name.padEnd(42)} ${r.domain.padEnd(32)} ${r.origin}`,
      );
    }
    const est = opts.source === "unavatar" ? todo.length * PRICE_PER_TOKEN : 0;
    console.log(`\ndry run — nothing fetched or written. Estimated cost: $${est.toFixed(2)}`);
    return;
  }

  let apiKey = "";
  if (opts.source === "unavatar") {
    apiKey = (await getSecret("UNAVATAR_API_KEY")) ?? "";
    if (!apiKey) {
      throw new Error("UNAVATAR_API_KEY is not set. Add it in Settings → Setup or web/.env.local.");
    }
  }

  let ok = 0;
  let missing = 0;
  let rejected = 0;
  let spentTokens = 0;
  let stopped: string | null = null;

  const results = await mapLimit(todo, CONCURRENCY, async (row) => {
    if (stopped) return null;
    // Reserve before the request, not after: the cap has to hold even when
    // several lookups are in flight at once.
    if (opts.source === "unavatar" && (spentTokens + 1) * PRICE_PER_TOKEN > opts.maxCost) {
      stopped = `spend cap $${opts.maxCost} reached`;
      return null;
    }

    let result: Fetched;
    try {
      result =
        opts.source === "unavatar"
          ? await fetchFromUnavatar(row.domain, apiKey)
          : await fetchFromDdg(row.domain);
    } catch (err) {
      stopped = (err as Error).message;
      return null;
    }
    spentTokens += result.tokens;

    if (!result.png) {
      if (result.note) rejected++;
      else missing++;
      console.log(`  ---  ${row.name.padEnd(42)} ${row.domain.padEnd(32)} ${result.note ?? "no logo"}`);
      return null;
    }
    ok++;
    console.log(
      `  ok   ${row.name.padEnd(42)} ${row.domain.padEnd(32)} ${(result.png.byteLength / 1024).toFixed(1)} KB  ${row.origin}`,
    );
    return {
      entityId: row.id,
      data: result.png.toString("base64"),
      contentType: "image/png",
      domain: row.domain,
    };
  });

  const inserts = results.filter(Boolean) as {
    entityId: number; data: string; contentType: string; domain: string;
  }[];

  for (const r of inserts) {
    await db
      .insert(entityLogos)
      .values(r)
      .onConflictDoUpdate({
        target: entityLogos.entityId,
        set: { data: r.data, contentType: r.contentType, domain: r.domain, updatedAt: new Date() },
      });
  }

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(entityLogos);
  console.log(`\nfetched ${ok}, no logo available ${missing}, rejected ${rejected}, cached total ${n}`);
  if (opts.source === "unavatar") {
    console.log(`unavatar tokens ${spentTokens} ≈ $${(spentTokens * PRICE_PER_TOKEN).toFixed(2)}`);
  }
  if (stopped) console.log(`STOPPED EARLY: ${stopped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
