/**
 * Hover, click, drag, and the focus dimming reducers — everything that makes
 * the canvas feel alive after build/layout/render have done their jobs.
 */
import type Graph from "graphology";
import type Sigma from "sigma";
import type { GraphPalette } from "./colors";
import type { LayoutHandle } from "./layout";

export type Selection =
  | { kind: "person"; id: number }
  | { kind: "company"; id: number }
  | null;

export function selectionKey(s: Selection): string | null {
  if (!s) return null;
  return s.kind === "person" ? `p${s.id}` : `e${s.id}`;
}

export function wireInteractions(
  renderer: Sigma,
  graph: Graph,
  layout: LayoutHandle,
  opts: {
    el: HTMLElement;
    onSelect: (s: Selection) => void;
    getSelected: () => Selection;
    palette: () => GraphPalette;
  },
): void {
  const { el, onSelect, getSelected, palette } = opts;

  // Dim everything not adjacent to the hovered/selected node
  let hovered: string | null = null;
  const focus = () => {
    const f = hovered ?? selectionKey(getSelected());
    // The focused node can vanish under a data refresh while still selected —
    // treat a vanished focus as none.
    return f && graph.hasNode(f) ? f : null;
  };

  renderer.setSetting("nodeReducer", (node, attrs) => {
    const f = focus();
    if (!f) return attrs;
    const isFocus = node === f;
    const isNeighbor = graph.areNeighbors(f, node);
    // Subtle: 1.5x read as a lunge; this is just enough to confirm focus
    if (isFocus) return { ...attrs, zIndex: 2, size: attrs.size * 1.12 };
    // Neighbors keep their color — hovering a hub lights its whole cluster
    if (isNeighbor) return { ...attrs, zIndex: 1 };
    return { ...attrs, color: palette().dimmed, label: "", zIndex: 0 };
  });
  renderer.setSetting("edgeReducer", (edge, attrs) => {
    const f = focus();
    if (!f) return attrs;
    return graph.hasExtremity(edge, f)
      ? { ...attrs, color: palette().accent, size: 1.6, zIndex: 1 }
      : { ...attrs, color: palette().edgeDim, zIndex: 0 };
  });

  renderer.on("enterNode", ({ node }) => {
    hovered = node;
    renderer.refresh();
    el.style.cursor = "pointer";
  });
  renderer.on("leaveNode", () => {
    hovered = null;
    renderer.refresh();
    el.style.cursor = "default";
  });

  // Drag state, shared between downNode / moveBody / up handlers
  let draggedNode: string | null = null;
  let didDrag = false;

  renderer.on("clickNode", ({ node }) => {
    // A drag ends with the pointer still on the node, which fires clickNode
    // too — don't treat repositioning as a selection.
    if (didDrag) {
      didDrag = false;
      return;
    }
    const attr = graph.getNodeAttributes(node);
    const isPerson = attr.kind === "person";
    onSelect(
      isPerson
        ? { kind: "person", id: attr.refId as number }
        : { kind: "company", id: attr.refId as number },
    );
    // Glide to what was clicked: enough zoom to read the cluster, without
    // yanking the viewport around — a person warrants a closer look than a hub.
    const pos = renderer.getNodeDisplayData(node);
    if (pos) {
      renderer
        .getCamera()
        .animate({ x: pos.x, y: pos.y, ratio: isPerson ? 0.2 : 0.35 }, { duration: 450 });
    }
  });
  // Clear without moving the camera — a misclick shouldn't cost your framing.
  renderer.on("clickStage", () => onSelect(null));

  /* --- Obsidian-style node dragging ----------------------------------- */
  renderer.on("downNode", ({ node }) => {
    draggedNode = node;
    didDrag = false;
    // Pause the simulation while the user holds the node — otherwise the
    // worker overwrites the dragged position every frame (a tug of war).
    layout.stop();
    // Freeze the bbox, or sigma re-normalizes coordinates every frame of
    // the drag and the whole graph slides under the cursor.
    if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox());
  });
  renderer.on("moveBody", ({ event }) => {
    if (!draggedNode || !graph.hasNode(draggedNode)) return;
    didDrag = true;
    const pos = renderer.viewportToGraph(event);
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
    if (didDrag) layout.settle(2500);
  };
  renderer.on("upNode", release);
  renderer.on("upStage", release);
}
