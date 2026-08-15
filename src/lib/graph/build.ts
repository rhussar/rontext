/**
 * Pure graph construction — no DOM, no Sigma. The canvas and
 * scripts/check-graph.ts both build through here, so what the headless checks
 * assert is exactly what the browser draws.
 */
import Graph from "graphology";
import { COMPANY_COLORS } from "./colors";
import type { GraphData } from "./query";

export type BuiltGraph = {
  graph: Graph;
  /** contact id → the company id whose cluster that person belongs to */
  primaryCompanyOf: Map<number, number>;
};

/** Node keys are prefixed so person and company ids can't collide. */
export const personKey = (id: number) => `p${id}`;
export const companyKey = (id: number) => `e${id}`;

/**
 * Build the undirected person↔company graph.
 *
 * No Louvain here, on purpose: in a bipartite people↔companies graph the
 * communities it finds are just… the companies, plus noise from people with
 * two employers. Clusters are keyed directly off each person's primary
 * employer instead — same picture, one less dependency, fully deterministic.
 */
export function buildCompanyGraph(
  data: GraphData,
  { edgeColor = "#e7e5e4" }: { edgeColor?: string } = {},
): BuiltGraph {
  const graph = new Graph({ type: "undirected" });

  // Payload-derived degree, not memberCount: memberCount includes archived
  // contacts, and a hub's drawn size should match the people actually shown.
  const drawnDegree = new Map<number, number>();
  const employers = new Map<number, number[]>();
  for (const edge of data.edges) {
    drawnDegree.set(edge.e, (drawnDegree.get(edge.e) ?? 0) + 1);
    const list = employers.get(edge.p);
    if (list) list.push(edge.e);
    else employers.set(edge.p, [edge.e]);
  }

  /**
   * Rank-ordered accents: the biggest clusters take the twelve distinct hues,
   * so a color only repeats between small clusters that land far apart.
   */
  const ranked = [...data.companies]
    .filter((c) => (drawnDegree.get(c.id) ?? 0) > 0)
    .sort((a, b) => b.memberCount - a.memberCount || a.id - b.id);
  const accentOf = new Map<number, string>();
  ranked.forEach((c, i) => accentOf.set(c.id, COMPANY_COLORS[i % COMPANY_COLORS.length]));

  const byId = new Map(data.companies.map((c) => [c.id, c]));

  /**
   * A person's cluster is their biggest connected company (ties to the lower
   * id) — deterministic, and it sends people with a job history to the
   * employer where they'll know the most faces.
   */
  const primaryCompanyOf = new Map<number, number>();
  for (const [pid, list] of employers) {
    let best = list[0];
    for (const cid of list) {
      const a = byId.get(cid)?.memberCount ?? 0;
      const b = byId.get(best)?.memberCount ?? 0;
      if (a > b || (a === b && cid < best)) best = cid;
    }
    primaryCompanyOf.set(pid, best);
  }

  for (const c of ranked) {
    graph.addNode(companyKey(c.id), {
      label: c.shortLabel,
      kind: "company",
      refId: c.id,
      size: Math.min(34, 8 + Math.sqrt(drawnDegree.get(c.id) ?? 0) * 3.4),
      // `drawingMode: "background"` paints this color behind the logo, so a
      // logo node needs white — the cluster accent would show through every
      // transparent pixel otherwise and muddy the mark.
      color: c.hasLogo ? "#ffffff" : accentOf.get(c.id),
      accent: accentOf.get(c.id),
      // Hubs with a cached logo render through the image program; the rest
      // stay plain circles, so partial logo coverage degrades gracefully.
      ...(c.hasLogo ? { type: "image", image: `/api/logos/${c.id}?v=${c.logoV}` } : {}),
    });
  }

  for (const p of data.people) {
    const list = employers.get(p.id);
    if (!list) continue; // unconnected people stay off-canvas by design
    const primary = primaryCompanyOf.get(p.id)!;
    graph.addNode(personKey(p.id), {
      label: p.name,
      kind: "person",
      refId: p.id,
      primary,
      // Someone with several employers is a connector — a notch bigger, but
      // kept well under the hubs so people read as texture around the discs.
      size: 3 + Math.min(3, (list.length - 1) * 1.2),
      color: accentOf.get(primary),
    });
  }

  /**
   * Cluster cohesion without Louvain: the edge to your primary employer pulls
   * hard (2.5×) while past-employer edges are loose tethers (0.7×) that
   * stretch long — a tight knot of people around each logo with a few visible
   * lines running off to previous companies. FA2 reads the `weight` edge
   * attribute by default; no force-setting changes needed.
   */
  for (const edge of data.edges) {
    const a = personKey(edge.p);
    const b = companyKey(edge.e);
    if (!graph.hasNode(a) || !graph.hasNode(b) || graph.hasEdge(a, b)) continue;
    graph.addEdge(a, b, {
      size: 0.6,
      color: edgeColor,
      weight: primaryCompanyOf.get(edge.p) === edge.e ? 2.5 : 0.7,
    });
  }

  return { graph, primaryCompanyOf };
}

/**
 * Seed: scatter the *clusters*, not the individuals.
 *
 * Two failed extremes led here (kept from the previous canvas). Circlepack
 * made the final silhouette a near-perfect disc — the sim preserves the seed's
 * outline, so a circular seed means a circular graph no matter how forces are
 * tuned. A pure random scatter of individuals never converged — attraction is
 * nearly flat at long range, so satellites seeded across the canvas from
 * their hub crawl for minutes.
 *
 * So each company lands at a random center in a rectangle matched to the
 * CONTAINER's aspect ratio (the sim roughly preserves the seed's outline, so
 * an aspect-matched seed settles into a layout that fills the pane), with its
 * people jittered tightly around it. That's why this runs inside mount(), not
 * at build — the container only has a real size once the ResizeObserver
 * admits it.
 *
 * Seeded rng: every load starts from the same arrangement, so the graph stays
 * familiar even though the live sim varies in the fine grain.
 */
export function seedPositions(built: BuiltGraph, width: number, height: number): void {
  const { graph } = built;
  const rng = mulberry32(7);
  const W = 1400;
  const H = Math.min(2400, Math.max(500, (W * height) / Math.max(1, width)));

  const centers = new Map<number, { x: number; y: number }>();
  const centerFor = (companyId: number) => {
    let c = centers.get(companyId);
    if (!c) {
      c = { x: rng() * W, y: rng() * H };
      centers.set(companyId, c);
    }
    return c;
  };

  graph.forEachNode((node, attr) => {
    // People scatter around their primary employer's center; the hub itself
    // sits in the middle of its own crowd.
    const center = centerFor(attr.kind === "company" ? (attr.refId as number) : (attr.primary as number));
    const angle = rng() * Math.PI * 2;
    const radius = attr.kind === "company" ? 0 : Math.sqrt(rng()) * 90; // sqrt: uniform over the disc
    graph.setNodeAttribute(node, "x", center.x + Math.cos(angle) * radius);
    graph.setNodeAttribute(node, "y", center.y + Math.sin(angle) * radius);
  });
}

/** Tiny seeded PRNG so the seed scatter is identical every load. */
export function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
