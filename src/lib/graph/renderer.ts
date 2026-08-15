/**
 * Sigma construction and theming. Everything here reads the palette through a
 * getter at draw time, never baked at mount — that's what lets a theme toggle
 * restyle the canvas with a refresh() instead of a remount.
 */
import type Graph from "graphology";
import Sigma from "sigma";
import { createNodeImageProgram } from "@sigma/node-image";
import { graphPalette, type GraphPalette } from "./colors";

/**
 * Labels centered *below* the node, the way Obsidian's graph does it.
 *
 * Sigma's default draws the label to the right of the node, where it runs
 * straight through whatever sits beside it. Below-and-centered means a label
 * only ever occupies the gap the layout already left underneath its own node.
 * The halo behind the glyphs keeps text legible where it crosses an edge.
 *
 * Hubs read as headings (600 weight, size tied to the disc), people as
 * captions (500 weight, fixed 11px). The branch keys off node size rather
 * than a custom attribute — company discs are always ≥8px, people ≤6px — so
 * it holds regardless of what Sigma passes through to display data.
 */
function makeDrawLabelBelow(palette: () => GraphPalette) {
  return function drawLabelBelow(
    context: CanvasRenderingContext2D,
    data: { x: number; y: number; size: number; label: string | null; color: string },
    settings: { labelFont: string },
  ) {
    if (!data.label) return;

    const isHub = data.size >= 8;
    const size = isHub ? Math.max(12, Math.min(16, 10 + data.size * 0.22)) : 11;
    context.font = `${isHub ? 600 : 500} ${size}px ${settings.labelFont}`;

    const width = context.measureText(data.label).width;
    const x = data.x - width / 2;
    const y = data.y + data.size + size + 2;

    context.strokeStyle = palette().halo;
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.strokeText(data.label, x, y);

    context.fillStyle = palette().label;
    context.fillText(data.label, x, y);
  };
}

export function createRenderer(
  graph: Graph,
  el: HTMLElement,
  palette: () => GraphPalette,
): Sigma {
  const drawLabelBelow = makeDrawLabelBelow(palette);

  return new Sigma(graph, el, {
    renderLabels: true,
    /**
     * Level of detail, controlled by two levers acting at opposite ends of
     * the zoom range:
     *
     * - `labelRenderedSizeThreshold` is in *rendered* pixels, so it gates
     *   which nodes are eligible at all. Zoomed out, only the largest hubs
     *   clear it — the overview shows company names and nothing else;
     *   zooming in grows every node past it, down to individual people.
     * - `labelDensity` / `labelGridCellSize` then cull collisions among the
     *   eligible ones. Zoomed out almost nothing is eligible, so density can
     *   be generous — which fills in mid-size hubs once you're zoomed in.
     */
    labelRenderedSizeThreshold: 12,
    labelDensity: 0.11,
    labelGridCellSize: 110,
    labelFont: "var(--font-geist-sans), system-ui, sans-serif",
    labelSize: 12,
    labelWeight: "500",
    labelColor: { color: palette().label },
    defaultDrawNodeLabel: drawLabelBelow,
    // Sigma's default hover renderer draws a white box with the label to the
    // RIGHT of the node. Reuse the below-the-node label instead, so hover
    // just guarantees the name shows (even when the density grid suppressed
    // it) without any box.
    defaultDrawNodeHover: drawLabelBelow,
    defaultEdgeColor: palette().edgeSoft,
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
        // Edge-to-edge, like a board-graph disc: the fetch pipeline flattens
        // and cover-fills the art, so any inset here would just re-introduce
        // the white ring it removes.
        padding: 0,
        drawLabel: drawLabelBelow,
        drawHover: drawLabelBelow, // image nodes must not fall back to the boxed hover
      }),
    },
  });
}

/**
 * Restyle on theme toggle. The theme lives as a class on <html> (set by
 * themeInitScript, outside React state), so the canvas watches the DOM
 * itself. Edge colors are *baked* into edge attributes at build time, so a
 * palette swap re-bakes them on the live graph; node colors (cluster
 * accents) are theme-stable and left alone.
 *
 * Returns a disconnect function for the unmount cleanup.
 */
export function watchTheme(
  graph: Graph,
  paletteRef: { current: GraphPalette },
  getRenderer: () => Sigma | null,
): () => void {
  const observer = new MutationObserver(() => {
    const dark = document.documentElement.classList.contains("dark");
    const p = graphPalette(dark);
    if (p.label === paletteRef.current.label) return; // class churn, no flip
    paletteRef.current = p;
    graph.updateEachEdgeAttributes((_e, attrs) => ({ ...attrs, color: p.edge }));
    const renderer = getRenderer();
    renderer?.setSetting("labelColor", { color: p.label });
    renderer?.setSetting("defaultEdgeColor", p.edgeSoft);
    renderer?.refresh();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}
