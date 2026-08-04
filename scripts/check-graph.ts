/**
 * Verify the graph payload and its structure without a browser:
 *   set -a && source .env.local && set +a && npx tsx scripts/check-graph.ts
 *
 * Asserts the known-answer cases measured from the source CSV, then builds the
 * same graphology graph the canvas builds and reports the clusters Louvain
 * finds. If the Syracuse and audit clusters don't separate, the edge
 * construction is wrong — not the layout settings.
 */
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import { getGraphData } from "../src/lib/actions/graph";

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

// Re-baselined after email-domain folding: several hubs legitimately grew when
// their domain twin merged in (RSM US absorbed rsmus.com, Syracuse absorbed
// syr.edu, Oxford Capital absorbed three Oxford Hotels domains).
const EXPECTED: [string, number][] = [
  ["KPMG", 11],
  ["RSM US", 25],
  ["EY", 15],
  ["PwC", 14],
  ["Deloitte", 14],
  ["Chicago", 59],
  ["New York City", 37],
  ["Syracuse University", 32],
  ["Oxford Capital Group", 31],
  ["JLL", 17],
];

async function main() {
  const data = await getGraphData();

  console.log("=== Payload ===");
  console.log(`  people (connected)   ${data.people.length}`);
  console.log(`  hubs (>=2 members)   ${data.entities.length}`);
  console.log(`  edges                ${data.edges.length}`);
  console.log(`  isolated (not drawn) ${data.isolatedCount} of ${data.totalContacts}`);
  console.log(`  payload size         ${(JSON.stringify(data).length / 1024).toFixed(0)} KB`);

  console.log("\n=== Known-answer checks ===");
  let failures = 0;
  const byName = new Map(data.entities.map((e) => [e.name, e]));
  for (const [name, expected] of EXPECTED) {
    const got = byName.get(name)?.memberCount;
    const ok = got !== undefined && Math.abs(got - expected) <= TOLERANCE;
    if (!ok) failures++;
    const drift = got !== undefined && got !== expected ? ` (drift ${got - expected > 0 ? "+" : ""}${got - expected})` : "";
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(16)} expected ~${expected}, got ${got ?? "missing"}${drift}`,
    );
  }

  // Over-merge guard: the bug we already fixed once must not come back.
  const junkDrawer = data.entities.find((e) => /\(other\)/i.test(e.name));
  if (junkDrawer) {
    failures++;
    console.log(`  FAIL  catch-all entity reappeared: "${junkDrawer.name}" (${junkDrawer.memberCount})`);
  } else {
    console.log("  PASS  no catch-all junk-drawer entity");
  }

  // Referential integrity — sigma throws on an edge to an unknown node.
  const pIds = new Set(data.people.map((p) => p.id));
  const eIds = new Set(data.entities.map((e) => e.id));
  const dangling = data.edges.filter((e) => !pIds.has(e.p) || !eIds.has(e.e));
  if (dangling.length) {
    failures++;
    console.log(`  FAIL  ${dangling.length} edges reference a node not in the payload`);
  } else {
    console.log("  PASS  every edge resolves to a node in the payload");
  }

  // ---- Rebuild the canvas graph and inspect the clusters -----------------
  const graph = new Graph({ type: "undirected" });
  for (const p of data.people) graph.addNode(`p${p.id}`, { kind: "person", label: p.name });
  for (const e of data.entities) graph.addNode(`e${e.id}`, { kind: "entity", label: e.name });
  for (const edge of data.edges) {
    const a = `p${edge.p}`;
    const b = `e${edge.e}`;
    if (!graph.hasEdge(a, b)) graph.addEdge(a, b);
  }
  console.log(`\n=== Graph ===`);
  console.log(`  order ${graph.order} nodes, size ${graph.size} edges`);

  louvain.assign(graph);
  const clusters = new Map<number, { people: number; hubs: string[] }>();
  graph.forEachNode((_n, attr) => {
    const c = attr.community as number;
    let bucket = clusters.get(c);
    if (!bucket) {
      bucket = { people: 0, hubs: [] };
      clusters.set(c, bucket);
    }
    if (attr.kind === "person") bucket.people++;
    else bucket.hubs.push(attr.label as string);
  });

  const ranked = [...clusters.entries()].sort((a, b) => b[1].people - a[1].people).slice(0, 8);
  console.log(`\n=== Top ${ranked.length} clusters (of ${clusters.size}) ===`);
  for (const [, b] of ranked) {
    console.log(`  ${String(b.people).padStart(4)} people  ::  ${b.hubs.slice(0, 6).join(", ")}`);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
