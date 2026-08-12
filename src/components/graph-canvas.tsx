"use client";

import { useEffect, useRef } from "react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import noverlap from "graphology-layout-noverlap";
import louvain from "graphology-communities-louvain";
import Sigma from "sigma";
import { createNodeImageProgram } from "@sigma/node-image";
import type { GraphData } from "@/lib/actions/graph";

import {
  COMMUNITY_COLORS,
  graphPalette,
  HUB_COLOR,
  HUB_COLOR_FALLBACK,
  type GraphPalette,
} from "@/lib/graph/colors";

export type Selection =
  | { kind: "person"; id: number }
  | { kind: "entity"; id: number }
  | null;

/**
 * Labels centered *below* the node, the way Obsidian's graph does it.
 *
 * Sigma's default draws the label to the right of the node, where it runs
 * straight through whatever sits beside it — which is why text looked
 * "covered". Below-and-centered means a label only ever occupies the gap the
 * layout already left underneath its own node.
 *
 * The white halo behind the glyphs keeps text legible where it crosses an edge
 * or a distant node, so labels stay readable without needing opaque boxes.
 */
function makeDrawLabelBelow(palette: () => GraphPalette) {
  return function drawLabelBelow(
    context: CanvasRenderingContext2D,
    data: { x: number; y: number; size: number; label: string | null; color: string },
    settings: { labelFont: string; labelWeight: string; labelColor: { color?: string } },
  ) {
    if (!data.label) return;

    // Tie label size to node size: hubs read as headings, people as captions.
    const size = Math.max(11, Math.min(15, 9 + data.size * 0.32));
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;

    const width = context.measureText(data.label).width;
    const x = data.x - width / 2;
    const y = data.y + data.size + size + 2;

    // Read through the closure at draw time, not baked at mount — this is what
    // lets a theme toggle restyle labels with a refresh() instead of a remount.
    context.strokeStyle = palette().halo;
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.strokeText(data.label, x, y);

    context.fillStyle = palette().label;
    context.fillText(data.label, x, y);
  };
}

/** Full pristine graph, captured once after seeding — the source of truth the
 *  type filter cuts from and restores to. */
type MasterGraph = ReturnType<Graph["export"]>;

/**
 * Which nodes the type filter hides: every entity of a toggled-off type, plus
 * any person whose visible affiliations ALL went with it — without the second
 * rule, hiding "place" would leave location-only people floating as orphan
 * dots with no edges.
 *
 * Computed against the MASTER snapshot, not the live graph: hidden nodes are
 * genuinely dropped from the graph (so the physics re-flows without them),
 * which means the live graph can't answer "what would be visible" questions.
 */
function computeHiddenNodes(
  master: MasterGraph,
  hiddenTypes: ReadonlySet<string>,
): Set<string> {
  const hidden = new Set<string>();
  if (hiddenTypes.size === 0) return hidden;

  for (const n of master.nodes) {
    const a = n.attributes as Record<string, unknown> | undefined;
    if (a?.kind === "entity" && hiddenTypes.has(a.entityType as string)) {
      hidden.add(n.key);
    }
  }

  const neighbors = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const arr = neighbors.get(from);
    if (arr) arr.push(to);
    else neighbors.set(from, [to]);
  };
  for (const e of master.edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }

  for (const n of master.nodes) {
    const a = n.attributes as Record<string, unknown> | undefined;
    if (a?.kind !== "person") continue;
    const nbs = neighbors.get(n.key) ?? [];
    if (!nbs.some((nb) => !hidden.has(nb))) hidden.add(n.key);
  }
  return hidden;
}

export function GraphCanvas({
  data,
  onSelect,
  selected,
  hiddenTypes,
}: {
  data: GraphData;
  onSelect: (s: Selection) => void;
  selected: Selection;
  /** Entity types toggled off in the view (company/school/place/group) */
  hiddenTypes: ReadonlySet<string>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  // Lets the node/edge reducers read the current selection without being
  // rebuilt (which would tear down and re-lay-out the whole graph).
  const selectedRef = useRef<Selection>(selected);
  // Same pattern for the type filter: the toggle effect calls into the build
  // effect's closure through this ref — the expensive build/layout effect
  // itself never re-runs on a toggle.
  const hiddenTypesRef = useRef<ReadonlySet<string>>(hiddenTypes);
  const applyFilterRef = useRef<(() => void) | null>(null);

  // Build the graph + layout once per dataset
  useEffect(() => {
    if (!containerRef.current) return;

    // Theme lives as a class on <html> (set by themeInitScript, outside React
    // state), so the canvas reads the DOM itself. A plain mutable object, read
    // by the reducers and label renderer at draw time; the MutationObserver
    // below swaps it and refreshes — no remount, no re-layout.
    const paletteRef = {
      current: graphPalette(document.documentElement.classList.contains("dark")),
    };
    const drawLabelBelow = makeDrawLabelBelow(() => paletteRef.current);

    const graph = new Graph({ type: "undirected" });

    for (const p of data.people) {
      graph.addNode(`p${p.id}`, {
        label: p.name,
        kind: "person",
        refId: p.id,
        size: 3,
        color: p.color,
      });
    }
    for (const e of data.entities) {
      graph.addNode(`e${e.id}`, {
        label: e.shortLabel,
        kind: "entity",
        refId: e.id,
        entityType: e.type,
        size: Math.min(26, 5 + Math.sqrt(e.memberCount) * 2.9),
        // `drawingMode: "background"` paints this colour behind the logo, so a
        // logo node needs white — the stone hub colour shows through every
        // transparent pixel otherwise and muddies the mark.
        color: e.hasLogo ? "#ffffff" : (HUB_COLOR[e.type] ?? HUB_COLOR_FALLBACK),
        // Hubs with a cached logo render through the image program; the rest
        // stay plain circles, so partial logo coverage degrades gracefully.
        ...(e.hasLogo ? { type: "image", image: `/api/logos/${e.id}?v=${e.logoV}` } : {}),
      });
    }
    for (const edge of data.edges) {
      const a = `p${edge.p}`;
      const b = `e${edge.e}`;
      if (graph.hasNode(a) && graph.hasNode(b) && !graph.hasEdge(a, b)) {
        graph.addEdge(a, b, { size: 0.6, color: paletteRef.current.edge });
      }
    }

    // Color people by community so the clusters are the thing you see first.
    // Hubs keep their type color — they're the labels, not the pattern.
    try {
      louvain.assign(graph, { rng: mulberry32(42) });
      graph.forEachNode((node, attr) => {
        if (attr.kind !== "person") return;
        const c = attr.community ?? 0;
        graph.setNodeAttribute(node, "color", COMMUNITY_COLORS[c % COMMUNITY_COLORS.length]);
      });
    } catch {
      // Louvain needs edges; an empty graph is not an error worth surfacing
    }

    // Size people by degree — someone on three hubs is a connector. Kept a
    // notch below the hubs so the person layer reads as texture around the
    // logo discs rather than competing with them.
    graph.forEachNode((node, attr) => {
      if (attr.kind !== "person") return;
      graph.setNodeAttribute(node, "size", 2.2 + Math.min(4, graph.degree(node) * 0.9));
    });

    /**
     * Cluster cohesion, from the data itself: weight each edge by whether it
     * stays inside its Louvain community. Members hug their own cluster
     * (2.5×), while a cross-community edge becomes a loose tether (0.7×)
     * that stretches long — a tight knot of people around Goldman with one
     * or two visible lines running off to Syracuse, instead of a milky field.
     * Cluster pairs that share MANY tethers still sum to a real pull, which
     * is what parks New York City beside RSM without merging them.
     *
     * No force-setting changes needed: FA2 reads the `weight` edge attribute
     * by default, and edgeWeightInfluence already defaults to 1.
     */
    graph.forEachEdge((edge, _attr, source, target) => {
      const same =
        graph.getNodeAttribute(source, "community") ===
        graph.getNodeAttribute(target, "community");
      graph.setEdgeAttribute(edge, "weight", same ? 2.5 : 0.7);
    });

    /**
     * Seed: scatter the *communities*, not the individuals.
     *
     * Two failed extremes led here. Circlepack made the final silhouette a
     * near-perfect disc — the sim preserves the seed's outline, and a
     * circular seed means a circular graph no matter how forces are tuned.
     * A pure random scatter of individuals never converged: linLog
     * attraction is logarithmic, nearly flat at long range, so satellites
     * seeded across the canvas from their hub crawl for minutes.
     *
     * So each Louvain community lands at a random center in a rectangle,
     * with its members jittered tightly around it. Members only need
     * *local* settling, while the global arrangement is random — the
     * boundary follows wherever clusters happened to land, so patterns show
     * instead of a disc.
     *
     * The rectangle matches the CONTAINER's aspect ratio — the sim roughly
     * preserves the seed's outline, so an aspect-matched seed settles into
     * a layout that fills the pane instead of leaving dead bands. That's
     * why this runs inside mount(), not here: the container only has a real
     * size once the ResizeObserver admits us.
     *
     * Seeded rng: every load starts from the same arrangement, so the graph
     * stays familiar even though the live sim varies in the fine grain.
     */
    const seedPositions = (width: number, height: number) => {
      const rng = mulberry32(7);
      const W = 1400;
      const H = Math.min(2400, Math.max(500, (W * height) / Math.max(1, width)));
      const centers = new Map<number, { x: number; y: number }>();
      graph.forEachNode((node, attr) => {
        const community = (attr.community as number | undefined) ?? -1;
        let center = centers.get(community);
        if (!center) {
          center = { x: rng() * W, y: rng() * H };
          centers.set(community, center);
        }
        const angle = rng() * Math.PI * 2;
        const radius = Math.sqrt(rng()) * 90; // sqrt: uniform over the disc
        graph.setNodeAttribute(node, "x", center.x + Math.cos(angle) * radius);
        graph.setNodeAttribute(node, "y", center.y + Math.sin(angle) * radius);
      });
    };

    /**
     * Obsidian-style live layout. Instead of computing positions once before
     * first paint, ForceAtlas2 runs in a web worker while sigma renders every
     * frame — the graph visibly unfolds from the packed seed, drifts apart
     * where it's crowded, and settles. `adjustSizes` is what does the
     * de-cluttering: nodes repel by their radius, so big hubs continuously
     * shove neighbours out of their space instead of sitting under them.
     *
     * The simulation is stopped after a few seconds (and re-woken briefly
     * after a drag) rather than left running: FA2 with `adjustSizes` never
     * fully converges, and a permanently-jittering graph reads as broken,
     * not alive. Trade-off vs. the old one-shot layout: final positions are
     * no longer pixel-identical across reloads — the seeded community
     * scatter keeps clusters in recognizable places, but the fine
     * arrangement varies.
     */
    const layout = new FA2Layout(graph, {
      settings: {
        ...forceAtlas2.inferSettings(graph),
        barnesHutOptimize: true,
        outboundAttractionDistribution: true, // keeps big hubs from dominating
        /**
         * linLog is OFF for spacing. Logarithmic attraction packs satellites
         * right up against their hub — tight clusters were the point when the
         * canvas was crowded with labels, but at disc-logo sizes it reads as
         * nodes piled on top of each other. Linear attraction's equilibrium
         * edge length is much longer, so fans open into orbits automatically.
         */
        linLogMode: false,
        /**
         * Near-zero on purpose. Gravity is a pull toward one global center,
         * and with ~130 disconnected islands that pull is what produced a
         * featureless disc — islands pack into a uniform ring around the
         * core, erasing every shape the data has. This low, the geometry is
         * decided by the edges instead: hub-and-spoke stars, chains through
         * shared people, irregular gaps. Islands still stop drifting because
         * Barnes-Hut repulsion fades with distance; sigma's auto-rescale
         * keeps the whole sprawl in view regardless of how far it reaches.
         */
        gravity: 0.05,
        /**
         * The spread lever. With intra-community attraction boosted 2.5×,
         * clusters hold together on their own — so the extra repulsion here
         * spends itself BETWEEN clusters, which is exactly where the empty
         * canvas space should go.
         */
        scalingRatio: 45,
        slowDown: 15, // stronger forces need more damping to stay calm
        adjustSizes: true,
      },
    });
    let settleTimer: number | null = null;
    /** Run the simulation for a bounded burst, extending if already running. */
    const settle = (ms: number) => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      if (!layout.isRunning()) layout.start();
      settleTimer = window.setTimeout(() => {
        layout.stop();
        relaxOverlaps();
      }, ms);
    };

    const el = containerRef.current;
    let renderer: Sigma | null = null;

    /**
     * Type-filter surgery. Hidden nodes are truly removed from the graph —
     * not just skipped at render — so the physics stops feeling their forces
     * and the survivors re-flow into the freed space on the follow-up settle.
     * Dropped nodes remember where they were (`lastPos`) and return there
     * when toggled back on, then re-settle with everyone else.
     */
    let master: MasterGraph | null = null;
    const lastPos = new Map<string, { x: number; y: number }>();

    const applyTypeFilter = (): boolean => {
      if (!master) return false;
      const hidden = computeHiddenNodes(master, hiddenTypesRef.current);
      let changed = false;

      for (const key of [...graph.nodes()]) {
        if (!hidden.has(key)) continue;
        const a = graph.getNodeAttributes(key);
        lastPos.set(key, { x: a.x as number, y: a.y as number });
        graph.dropNode(key); // drops incident edges with it
        changed = true;
      }

      for (const n of master.nodes) {
        if (hidden.has(n.key) || graph.hasNode(n.key)) continue;
        graph.addNode(n.key, { ...n.attributes, ...lastPos.get(n.key) });
        changed = true;
      }

      for (const e of master.edges) {
        if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
        if (graph.hasEdge(e.source, e.target)) continue;
        graph.addEdge(e.source, e.target, { ...e.attributes });
        changed = true;
      }

      return changed;
    };

    // What the toggle effect calls. Stop first: the worker snapshots the node
    // set at start(), so mutating mid-run would have it writing positions for
    // nodes that no longer exist.
    applyFilterRef.current = () => {
      layout.stop();
      if (applyTypeFilter()) settle(2200);
    };

    /**
     * Anti-collision pass, run every time the simulation comes to rest. FA2's
     * `adjustSizes` only discourages overlap while forces are live — whatever
     * residual overlap exists at stop time would freeze in, which is exactly
     * the logos-over-people piling being fixed here. Noverlap iteratively
     * nudges offenders apart until nothing touches, so the *resting* state is
     * guaranteed clean; motion during the settle may still overlap, which
     * reads as physics rather than clutter.
     *
     * The size conversion is load-bearing: sigma sizes are *screen pixels*
     * while positions are graph units, and after auto-rescale one pixel is
     * worth `span / canvas` units. Passing raw pixel sizes would under-correct
     * by exactly that factor — worst on the big logo discs, which are the most
     * visible offenders.
     */
    const relaxOverlaps = () => {
      if (graph.order === 0 || el.clientWidth === 0) return;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      graph.forEachNode((_n, a) => {
        if (a.x < minX) minX = a.x;
        if (a.x > maxX) maxX = a.x;
        if (a.y < minY) minY = a.y;
        if (a.y > maxY) maxY = a.y;
      });
      const unitsPerPx =
        Math.max((maxX - minX) / el.clientWidth, (maxY - minY) / el.clientHeight) || 1;
      noverlap.assign(graph, {
        maxIterations: 200,
        // +2px so nodes rest with a hairline of air, not kissing edges
        inputReducer: (_k, attr) => ({
          ...attr,
          size: ((attr.size ?? 3) + 2) * unitsPerPx,
        }),
        settings: { ratio: 1, margin: 0, speed: 2 },
      });
    };

    // Dim everything not adjacent to the hovered/selected node
    let hovered: string | null = null;
    const focus = () => hovered ?? selectionKey(selectedRef.current);

    // Drag state, shared between downNode / moveBody / up handlers
    let draggedNode: string | null = null;
    let didDrag = false;

    /**
     * Sigma throws "Container has no width" if it is constructed before flex
     * layout has given the container a size — which is exactly what happens on
     * a dynamically-imported canvas inside `flex-1`. Wait for a real
     * measurement (via ResizeObserver) before constructing.
     */
    function mount() {
      if (renderer || el.offsetWidth === 0 || el.offsetHeight === 0) return;

      // Seed to the container's real aspect. The `renderer` guard above makes
      // this once-only, and Sigma below requires every node to have x/y.
      seedPositions(el.clientWidth, el.clientHeight);

      // Pristine copy with seeded positions — what the type filter cuts from
      // and restores to. Applied immediately in case a filter survived a
      // data refresh (the toggle effect won't re-fire for an unchanged set).
      master = graph.export();
      applyTypeFilter();

      renderer = new Sigma(graph, el, {
        renderLabels: true,
        /**
         * Level of detail, controlled by two levers that act at opposite ends
         * of the zoom range:
         *
         * - `labelRenderedSizeThreshold` is in *rendered* pixels, so it gates
         *   which nodes are eligible at all. Zoomed out, only the largest hubs
         *   clear 11px, which is what keeps the overview uncluttered; zooming
         *   in grows every node past it, down to individual people.
         * - `labelDensity` / `labelGridCellSize` then cull collisions among the
         *   eligible ones. Zoomed out almost nothing is eligible, so density
         *   barely applies — meaning it can be generous without hurting the
         *   overview, and generous is what fills in mid-size hubs once you're
         *   zoomed in and have the room.
         */
        labelRenderedSizeThreshold: 12,
        labelDensity: 0.11,
        labelGridCellSize: 110,
        labelFont: "var(--font-geist-sans), system-ui, sans-serif",
        labelSize: 12,
        labelWeight: "500",
        labelColor: { color: paletteRef.current.label },
        defaultDrawNodeLabel: drawLabelBelow,
        // Sigma's default hover renderer draws a white box with the label to
        // the RIGHT of the node — the stray "additional title". Reuse the
        // below-the-node label instead, so hover just guarantees the name
        // shows (even when the density grid suppressed it) without any box.
        defaultDrawNodeHover: drawLabelBelow,
        defaultEdgeColor: paletteRef.current.edgeSoft,
        zIndex: true, // draw big hubs above the dust
        minCameraRatio: 0.06,
        maxCameraRatio: 4,
        nodeProgramClasses: {
          // The image program carries its own label renderer, so it has to be
          // handed the same below-the-node one — otherwise logo hubs would
          // silently fall back to Sigma's right-side labels.
          image: createNodeImageProgram({
            drawingMode: "background",
            keepWithinCircle: true,
            // Edge-to-edge, like a board-graph disc: the fetch pipeline now
            // flattens and cover-fills the art, so any inset here would just
            // re-introduce the white ring it removes.
            padding: 0,
            drawLabel: drawLabelBelow,
            drawHover: drawLabelBelow, // image nodes must not fall back to the boxed hover
          }),
        },
      });

      wireUp(renderer);
      sigmaRef.current = renderer;
      graphRef.current = graph;

      // The load-time condensation: start simulating only once the canvas is
      // actually visible, so the settle happens on screen rather than before.
      // Longer than the packed-seed version needed — clusters have to find
      // each other out of the scatter first.
      settle(8000);
    }

    function wireUp(r: Sigma) {
      r.setSetting("nodeReducer", (node, attrs) => {
        // The focused node may have been surgically removed by a type toggle
        // while still hovered/selected — treat a vanished focus as none.
        const f0 = focus();
        const f = f0 && graph.hasNode(f0) ? f0 : null;
        if (!f) return attrs;
        const isFocus = node === f;
        const isNeighbor = graph.areNeighbors(f, node);
        // Subtle: 1.5x read as a lunge; this is just enough to confirm focus
        if (isFocus) return { ...attrs, zIndex: 2, size: attrs.size * 1.12 };
        if (isNeighbor) return { ...attrs, zIndex: 1 };
        return { ...attrs, color: paletteRef.current.dimmed, label: "", zIndex: 0 };
      });
      r.setSetting("edgeReducer", (edge, attrs) => {
        const f0 = focus();
        const f = f0 && graph.hasNode(f0) ? f0 : null;
        if (!f) return attrs;
        return graph.hasExtremity(edge, f)
          ? { ...attrs, color: "#2563eb", size: 1.6, zIndex: 1 }
          : { ...attrs, color: paletteRef.current.edgeDim, zIndex: 0 };
      });

      r.on("enterNode", ({ node }) => {
        hovered = node;
        r.refresh();
        el.style.cursor = "pointer";
      });
      r.on("leaveNode", () => {
        hovered = null;
        r.refresh();
        el.style.cursor = "default";
      });
      r.on("clickNode", ({ node }) => {
        // A drag ends with the pointer still on the node, which fires
        // clickNode too — don't treat repositioning as a selection.
        if (didDrag) {
          didDrag = false;
          return;
        }
        const attr = graph.getNodeAttributes(node);
        onSelect(
          attr.kind === "person"
            ? { kind: "person", id: attr.refId as number }
            : { kind: "entity", id: attr.refId as number },
        );
      });
      r.on("clickStage", () => onSelect(null));

      /* --- Obsidian-style node dragging --------------------------------- */
      r.on("downNode", ({ node }) => {
        draggedNode = node;
        didDrag = false;
        // Pause the simulation while the user holds the node — otherwise the
        // worker overwrites the dragged position every frame (a tug of war).
        layout.stop();
        // Freeze the bbox, or sigma re-normalizes coordinates every frame of
        // the drag and the whole graph slides under the cursor.
        if (!r.getCustomBBox()) r.setCustomBBox(r.getBBox());
      });
      r.on("moveBody", ({ event }) => {
        // hasNode: a type toggle can surgically remove the node mid-drag
        if (!draggedNode || !graph.hasNode(draggedNode)) return;
        didDrag = true;
        const pos = r.viewportToGraph(event);
        graph.setNodeAttribute(draggedNode, "x", pos.x);
        graph.setNodeAttribute(draggedNode, "y", pos.y);
        // Dragging a node must not also pan the camera
        event.preventSigmaDefault();
        event.original.preventDefault();
        event.original.stopPropagation();
      });
      const release = () => {
        if (!draggedNode) return;
        draggedNode = null;
        // The "alive" response: neighbours re-settle around the drop point
        if (didDrag) settle(2500);
      };
      r.on("upNode", release);
      r.on("upStage", release);
    }

    const observer = new ResizeObserver(() => mount());
    observer.observe(el);
    mount(); // already sized on a client-side nav

    // Restyle on theme toggle. Edge colors are *baked* into edge attributes at
    // build time, so a palette swap has to re-bake them — on the live graph AND
    // on the master snapshot, or a later type-filter restore would resurrect
    // the old theme's edges. Node colors (communities, hub types) are
    // theme-stable and left alone.
    const themeObserver = new MutationObserver(() => {
      const dark = document.documentElement.classList.contains("dark");
      const p = graphPalette(dark);
      if (p.label === paletteRef.current.label) return; // class churn, no flip
      paletteRef.current = p;
      graph.updateEachEdgeAttributes((_e, attrs) => ({ ...attrs, color: p.edge }));
      if (master) for (const e of master.edges) {
        if (e.attributes) e.attributes.color = p.edge;
      }
      renderer?.setSetting("labelColor", { color: p.label });
      renderer?.setSetting("defaultEdgeColor", p.edgeSoft);
      renderer?.refresh();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      layout.kill(); // terminates the worker — required, or it leaks per mount
      renderer?.kill();
      sigmaRef.current = null;
      graphRef.current = null;
      applyFilterRef.current = null;
    };
  }, [data, onSelect]);

  // Repaint when the selection changes from outside the canvas
  useEffect(() => {
    selectedRef.current = selected;
    sigmaRef.current?.refresh();
  }, [selected]);

  // Type filter changed: run the surgery in the build effect's closure. The
  // graph re-flows into the freed space via a short settle (and the noverlap
  // pass at its end), which is the point of removing rather than just hiding.
  useEffect(() => {
    hiddenTypesRef.current = hiddenTypes;
    applyFilterRef.current?.();
  }, [hiddenTypes]);

  return <div ref={containerRef} className="absolute inset-0" />;
}

function selectionKey(s: Selection): string | null {
  if (!s) return null;
  return s.kind === "person" ? `p${s.id}` : `e${s.id}`;
}

/** Tiny seeded PRNG so Louvain gives the same communities every run. */
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
