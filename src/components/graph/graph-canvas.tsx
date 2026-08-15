"use client";

import { useEffect, useRef } from "react";
import type Sigma from "sigma";
import { buildCompanyGraph, seedPositions } from "@/lib/graph/build";
import { graphPalette } from "@/lib/graph/colors";
import type { GraphData } from "@/lib/graph/query";
import { createLayout } from "@/lib/graph/layout";
import { createRenderer, watchTheme } from "@/lib/graph/renderer";
import { wireInteractions, type Selection } from "@/lib/graph/interactions";

export type { Selection };

/**
 * The canvas is a thin sequencer over the lib modules: build → seed → layout →
 * render → interactions. All the actual logic lives in src/lib/graph/*, where
 * scripts/check-graph.ts can exercise it headlessly.
 */
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
  // Lets the reducers read the current selection without being rebuilt
  // (which would tear down and re-lay-out the whole graph).
  const selectedRef = useRef<Selection>(selected);

  // Build the graph + layout once per dataset
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const paletteRef = {
      current: graphPalette(document.documentElement.classList.contains("dark")),
    };
    const palette = () => paletteRef.current;

    const built = buildCompanyGraph(data, { edgeColor: paletteRef.current.edge });
    const { graph } = built;
    const layout = createLayout(graph, el);
    let renderer: Sigma | null = null;

    /**
     * Sigma throws "Container has no width" if it is constructed before flex
     * layout has given the container a size — which is exactly what happens
     * on a dynamically-imported canvas inside `flex-1`. Wait for a real
     * measurement (via ResizeObserver) before constructing.
     */
    function mount() {
      if (renderer || !el || el.offsetWidth === 0 || el.offsetHeight === 0) return;

      // Seed to the container's real aspect. The `renderer` guard above makes
      // this once-only, and Sigma below requires every node to have x/y.
      seedPositions(built, el.clientWidth, el.clientHeight);

      renderer = createRenderer(graph, el, palette);
      wireInteractions(renderer, graph, layout, {
        el,
        onSelect,
        getSelected: () => selectedRef.current,
        palette,
      });
      sigmaRef.current = renderer;

      // The load-time condensation: start simulating only once the canvas is
      // actually visible, so the settle happens on screen rather than before.
      layout.settle(8000);
    }

    const observer = new ResizeObserver(() => mount());
    observer.observe(el);
    mount(); // already sized on a client-side nav

    const unwatchTheme = watchTheme(graph, paletteRef, () => renderer);

    return () => {
      observer.disconnect();
      unwatchTheme();
      layout.kill();
      renderer?.kill();
      sigmaRef.current = null;
    };
  }, [data, onSelect]);

  // Repaint when the selection changes from outside the canvas
  useEffect(() => {
    selectedRef.current = selected;
    sigmaRef.current?.refresh();
  }, [selected]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
