/**
 * Give every place hub an initial icon:
 *   set -a && source .env.local && set +a && npx tsx scripts/seed-place-icons.ts
 *   … --force   regenerate even places that already have an icon
 *
 * Places have no favicon to fetch, so the initial pass is a generated
 * lettermark — a teal circle (the place hub color) with the city's initials.
 * They're stored in entity_logos like any fetched logo, so the manager popover
 * can replace one with a real image at any time; a lettermark never overwrites
 * an upload unless --force is passed.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import sharp from "sharp";
import { getDb } from "../src/db";
import { entities, entityLogos } from "../src/db/schema";

const SIZE = 256;
/** Matches HUB_COLOR.place in src/lib/graph/colors.ts */
const PLACE_COLOR = "#0f766e";

/** "Chicago" -> "CH", "New York City" -> "NY", "San Francisco Bay Area" -> "SF" */
function placeInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

async function lettermark(initials: string): Promise<Buffer> {
  // Full-bleed square, not an inscribed circle: the canvas crops the image to
  // the node's circle, so painting the whole square gives an edge-to-edge
  // colour disc with no antialiased white sliver at the rim.
  const svg = `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${SIZE}" height="${SIZE}" fill="${PLACE_COLOR}"/>
  <text x="${SIZE / 2}" y="${SIZE / 2}" dy="0.36em" text-anchor="middle"
    font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(SIZE * 0.41)}" font-weight="600"
    fill="#ffffff">${initials}</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  const force = process.argv.includes("--force");
  const db = getDb();

  const places = await db
    .select({ id: entities.id, name: entities.name })
    .from(entities)
    .where(and(eq(entities.type, "place"), gte(entities.memberCount, 2)));

  const existing = await db
    .select({ entityId: entityLogos.entityId })
    .from(entityLogos);
  const have = new Set(existing.map((e) => e.entityId));

  const todo = force ? places : places.filter((p) => !have.has(p.id));
  console.log(`place hubs: ${places.length}, generating: ${todo.length}\n`);

  for (const place of todo) {
    const initials = placeInitials(place.name);
    const png = await lettermark(initials);
    await db
      .insert(entityLogos)
      .values({
        entityId: place.id,
        data: png.toString("base64"),
        contentType: "image/png",
        domain: "lettermark",
      })
      .onConflictDoUpdate({
        target: entityLogos.entityId,
        set: {
          data: png.toString("base64"),
          contentType: "image/png",
          domain: "lettermark",
          updatedAt: new Date(),
        },
      });
    console.log(`  ${initials.padEnd(4)} ${place.name}`);
  }

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(entityLogos);
  console.log(`\ncached logos/icons total: ${n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
