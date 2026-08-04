"use client";

import { useEffect, useRef } from "react";
import Graph from "graphology";
import circlepack from "graphology-layout/circlepack";
import forceAtlas2 from "graphology-layout-forceatlas2";
import louvain from "graphology-communities-louvain";
import Sigma from "sigma";
import type { GraphData } from "@/lib/actions/graph";

import {
  COMMUNITY_COLORS,
  DIMMED,
  HUB_COLOR,
  HUB_COLOR_FALLBACK,
} from "@/lib/graph/colors";

export type Selection =
  | { kind: "person"; id: number }
  | { kind: "entity"; id: number }
  | null;

export function GraphCanvas({
  data,
  onSelect,
  selected,
}: {
  data: GraphData;
  onSelect: (s: Selection) => void;
  selected: Selection;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  // Lets the node/edge reducers read the current selection without being
  // rebuilt (which would tear down and re-lay-out the whole graph).
  const selectedRef = useRef<Selection>(selected);

  // Build the graph + layout once per dataset
  useEffect(() => {
    if (!containerRef.current) return;

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
        size: Math.min(20, 3.5 + Math.sqrt(e.memberCount) * 2.4),
        color: HUB_COLOR[e.type] ?? HUB_COLOR_FALLBACK,
      });
    }
    for (const edge of data.edges) {
      const a = `p${edge.p}`;
      const b = `e${edge.e}`;
      if (graph.hasNode(a) && graph.hasNode(b) && !graph.hasEdge(a, b)) {
        graph.addEdge(a, b, { size: 0.6, color: "#e7e5e4" });
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

    // Size people by degree — someone on three hubs is a connector
    graph.forEachNode((node, attr) => {
      if (attr.kind !== "person") return;
      graph.setNodeAttribute(node, "size", 2.5 + Math.min(4, graph.degree(node) * 0.9));
    });

    /**
     * This network is not one connected blob — it's ~130 near-disjoint islands
     * (887 nodes, ~800 edges), because most people share an affiliation with
     * only a handful of others. Plain ForceAtlas2 arranges disconnected
     * components in a giant ring, which is both ugly and unreadable.
     *
     * So: pack each Louvain community into its own circle, then run a short
     * FA2 pass *within* that arrangement to spread members around their hub.
     * Deterministic input + deterministic passes => the same layout on every
     * reload, so spatial memory of the network survives a refresh.
     */
    circlepack.assign(graph, {
      hierarchyAttributes: ["community"],
      scale: 1.15,
    });
    forceAtlas2.assign(graph, {
      iterations: 60,
      settings: {
        ...forceAtlas2.inferSettings(graph),
        barnesHutOptimize: true,
        outboundAttractionDistribution: true, // keeps big hubs from dominating
        gravity: 0.05, // near-zero: don't drag the packed islands together
        scalingRatio: 3,
        slowDown: 20,
        adjustSizes: true,
      },
    });

    const el = containerRef.current;
    let renderer: Sigma | null = null;

    // Dim everything not adjacent to the hovered/selected node
    let hovered: string | null = null;
    const focus = () => hovered ?? selectionKey(selectedRef.current);

    /**
     * Sigma throws "Container has no width" if it is constructed before flex
     * layout has given the container a size — which is exactly what happens on
     * a dynamically-imported canvas inside `flex-1`. Wait for a real
     * measurement (via ResizeObserver) before constructing.
     */
    function mount() {
      if (renderer || el.offsetWidth === 0 || el.offsetHeight === 0) return;

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
        labelRenderedSizeThreshold: 11,
        labelDensity: 0.18,
        labelGridCellSize: 90,
        labelFont: "var(--font-geist-sans), system-ui, sans-serif",
        labelSize: 11,
        labelWeight: "500",
        labelColor: { color: "#44403c" },
        defaultEdgeColor: "#ededec",
        zIndex: true, // draw big hubs above the dust
        minCameraRatio: 0.06,
        maxCameraRatio: 4,
      });

      wireUp(renderer);
      sigmaRef.current = renderer;
      graphRef.current = graph;
    }

    function wireUp(r: Sigma) {
      r.setSetting("nodeReducer", (node, attrs) => {
      const f = focus();
      if (!f) return attrs;
        const isFocus = node === f;
        const isNeighbor = graph.areNeighbors(f, node);
        if (isFocus) return { ...attrs, zIndex: 2, size: attrs.size * 1.5 };
        if (isNeighbor) return { ...attrs, zIndex: 1 };
        return { ...attrs, color: DIMMED, label: "", zIndex: 0 };
      });
      r.setSetting("edgeReducer", (edge, attrs) => {
        const f = focus();
        if (!f) return attrs;
        return graph.hasExtremity(edge, f)
          ? { ...attrs, color: "#2563eb", size: 1.6, zIndex: 1 }
          : { ...attrs, color: "#f5f5f4", zIndex: 0 };
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
        const attr = graph.getNodeAttributes(node);
        onSelect(
          attr.kind === "person"
            ? { kind: "person", id: attr.refId as number }
            : { kind: "entity", id: attr.refId as number },
        );
      });
      r.on("clickStage", () => onSelect(null));
    }

    const observer = new ResizeObserver(() => mount());
    observer.observe(el);
    mount(); // already sized on a client-side nav

    return () => {
      observer.disconnect();
      renderer?.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [data, onSelect]);

  // Repaint when the selection changes from outside the canvas
  useEffect(() => {
    selectedRef.current = selected;
    sigmaRef.current?.refresh();
  }, [selected]);

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
