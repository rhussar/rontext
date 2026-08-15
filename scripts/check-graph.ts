/**
 * Verify the graph payload and its structure without a browser:
 *   set -a && source .env.local && set +a && npx tsx scripts/check-graph.ts
 *
 * Asserts the known-answer cases measured from the source CSV, then builds
 * the graph THROUGH THE SAME CODE the canvas uses (src/lib/graph/build.ts) —
 * so a drift between what this checks and what the browser draws is
 * impossible by construction.
 */
import { buildCompanyGraph } from "../src/lib/graph/build";
import { getCompanyGraphData, MIN_HUB_SIZE } from "../src/lib/graph/query";

/**
 * Known-answer counts, measured from the source CSV.
 *
 * Compared with a small tolerance on purpose: contacts are edited and imported
 * while this runs, so an exact-equality assertion turns every ordinary data
 * change into a false failure. The point is to catch a resolution regression
 * (a hub splitting in half, or two firms fusing), which moves these by far
 * more than TOLERANCE.
 */
const TOLERANCE = 2;

// Companies only — the view no longer draws schools, places or groups.
const EXPECTED: [string, number][] = [
  ["KPMG", 11],
  ["RSM US", 25],
  ["EY", 15],
  ["PwC", 14],
  ["Deloitte", 14],
  ["Oxford Capital Group", 31],
  ["JLL", 17],
];

/** Hubs that exist in the entity tables but must never reach this payload. */
const NON_COMPANY_HUBS = ["Chicago", "New York City", "Syracuse University"];

async function main() {
  const data = await getCompanyGraphData();

  console.log("=== Payload ===");
  console.log(`  people (connected)      ${data.people.length}`);
  console.log(`  companies (>=${MIN_HUB_SIZE} members) ${data.companies.length}`);
  console.log(`  edges                   ${data.edges.length}`);
  console.log(`  unconnected (not drawn) ${data.unconnectedCount} of ${data.totalContacts}`);
  console.log(`  payload size            ${(JSON.stringify(data).length / 1024).toFixed(0)} KB`);

  console.log("\n=== Known-answer checks ===");
  let failures = 0;
  const byName = new Map(data.companies.map((c) => [c.name, c]));
  for (const [name, expected] of EXPECTED) {
    const got = byName.get(name)?.memberCount;
    const ok = got !== undefined && Math.abs(got - expected) <= TOLERANCE;
    if (!ok) failures++;
    const drift = got !== undefined && got !== expected ? ` (drift ${got - expected > 0 ? "+" : ""}${got - expected})` : "";
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(20)} expected ~${expected}, got ${got ?? "missing"}${drift}`,
    );
  }

  // The company-only gate itself: a school or place leaking back into the
  // payload means the query's type filter regressed.
  const leaked = NON_COMPANY_HUBS.filter((n) => byName.has(n));
  if (leaked.length) {
    failures++;
    console.log(`  FAIL  non-company hubs in payload: ${leaked.join(", ")}`);
  } else {
    console.log("  PASS  no school/place/group hubs in the payload");
  }

  // Over-merge guard: the bug we already fixed once must not come back.
  const junkDrawer = data.companies.find((c) => /\(other\)/i.test(c.name));
  if (junkDrawer) {
    failures++;
    console.log(`  FAIL  catch-all entity reappeared: "${junkDrawer.name}" (${junkDrawer.memberCount})`);
  } else {
    console.log("  PASS  no catch-all junk-drawer entity");
  }

  // Referential integrity — sigma throws on an edge to an unknown node.
  const pIds = new Set(data.people.map((p) => p.id));
  const eIds = new Set(data.companies.map((c) => c.id));
  const dangling = data.edges.filter((e) => !pIds.has(e.p) || !eIds.has(e.e));
  if (dangling.length) {
    failures++;
    console.log(`  FAIL  ${dangling.length} edges reference a node not in the payload`);
  } else {
    console.log("  PASS  every edge resolves to a node in the payload");
  }

  // ---- Build the canvas graph through the real build code ----------------
  const { graph } = buildCompanyGraph(data);
  console.log(`\n=== Graph (via buildCompanyGraph) ===`);
  console.log(`  order ${graph.order} nodes, size ${graph.size} edges`);

  const hubs: { label: string; degree: number; people: number }[] = [];
  graph.forEachNode((node, attr) => {
    if (attr.kind !== "company") return;
    let people = 0;
    graph.forEachNeighbor(node, () => people++);
    hubs.push({ label: attr.label as string, degree: graph.degree(node), people });
  });
  hubs.sort((a, b) => b.people - a.people);
  console.log(`\n=== Top 8 hubs by drawn degree (of ${hubs.length}) ===`);
  for (const h of hubs.slice(0, 8)) {
    console.log(`  ${String(h.people).padStart(4)} people  ::  ${h.label}`);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
