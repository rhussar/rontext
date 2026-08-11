/**
 * Fetch and cache company logos:
 *   set -a && source .env.local && set +a && npx tsx scripts/fetch-logos.ts
 *   … --force   re-fetch even entities that already have a logo
 *
 * Runs locally, not on Vercel: it's a one-off backfill, and keeping `sharp`
 * out of the serverless bundle avoids a native-binary deploy problem for no
 * benefit. Only company domains leave the machine, and only once — after this
 * the browser reads logos from our own /api/logos route.
 */
import { eq, gte, isNotNull, sql } from "drizzle-orm";
import decodeIco from "decode-ico";
import sharp from "sharp";
import { getDb } from "../src/db";
import { entities, entityLogos } from "../src/db/schema";

/**
 * Texture resolution follows the cached image (@sigma/node-image sizes its
 * atlas from the source), so this IS the on-screen ceiling. 256 keeps discs
 * crisp on retina and under zoom — many brand ICOs ship a 256px frame, and
 * the decoder already picks the largest, so this stops throwing it away.
 */
const SIZE = 256;
const CONCURRENCY = 6;

type Row = { id: number; name: string; domain: string };

async function fetchLogo(domain: string): Promise<Buffer | null> {
  const url = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    return null;
  }
  // DDG answers 404 with a generic letter-tile placeholder — that's worse than
  // our own lettermark fallback, so treat it as "no logo" rather than cache it.
  if (!res.ok) return null;

  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.byteLength === 0) return null;

  try {
    return await toPng(raw);
  } catch {
    return null; // unparseable icon — fall back to the circle
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

async function main() {
  const force = process.argv.includes("--force");
  const db = getDb();

  const rows = await db
    .select({
      id: entities.id,
      name: entities.name,
      domain: sql<string>`${entities.metadata}->>'domain'`,
      memberCount: entities.memberCount,
    })
    .from(entities)
    .where(gte(entities.memberCount, 2));

  const targets = rows.filter((r): r is Row & { memberCount: number } => Boolean(r.domain));

  const existing = await db.select({ entityId: entityLogos.entityId }).from(entityLogos);
  const have = new Set(existing.map((e) => e.entityId));
  const todo = force ? targets : targets.filter((t) => !have.has(t.id));

  console.log(`hubs with >=2 members: ${rows.length}`);
  console.log(`  with a domain:        ${targets.length}`);
  console.log(`  already cached:       ${targets.length - todo.length}`);
  console.log(`  fetching:             ${todo.length}\n`);

  let ok = 0;
  let missing = 0;
  const results = await mapLimit(todo, CONCURRENCY, async (row) => {
    const png = await fetchLogo(row.domain);
    if (!png) {
      missing++;
      console.log(`  ---  ${row.name} (${row.domain})`);
      return null;
    }
    ok++;
    console.log(`  ok   ${row.name.padEnd(30)} ${row.domain.padEnd(28)} ${(png.byteLength / 1024).toFixed(1)} KB`);
    return { entityId: row.id, data: png.toString("base64"), contentType: "image/png", domain: row.domain };
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
  console.log(`\nfetched ${ok}, no logo available ${missing}, cached total ${n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { isNotNull, eq };
