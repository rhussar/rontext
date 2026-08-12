/**
 * Graph palette. Shared by the WebGL canvas and the legend so the two can't
 * drift — a legend that disagrees with the canvas is worse than no legend.
 */

/**
 * Companies are the overwhelming majority of hubs (~145 of 172), so they get a
 * neutral stone that recedes; near-black at that count reads as a wall of dots
 * and flattens the hierarchy. The rarer types keep saturated colors so schools,
 * places and groups stay findable at a glance.
 */
export const HUB_COLOR: Record<string, string> = {
  company: "#57534e", // stone-600
  school: "#9a3412", // orange-800
  place: "#0f766e", // teal-700
  group: "#7e22ce", // purple-700
  industry: "#57534e",
  function: "#57534e",
};

export const HUB_COLOR_FALLBACK = "#57534e";

/** Legend rows, in the order they're drawn. */
export const HUB_LEGEND: { type: string; label: string }[] = [
  { type: "company", label: "Company" },
  { type: "school", label: "School" },
  { type: "place", label: "Place" },
  { type: "group", label: "Group" },
];

/** Person nodes are colored by Louvain community, not by type. */
export const COMMUNITY_COLORS = [
  "#0ea5e9", "#10b981", "#8b5cf6", "#f59e0b", "#f43f5e",
  "#14b8a6", "#6366f1", "#f97316", "#0891b2", "#d946ef",
  "#84cc16", "#ec4899",
];

/** Neutral used for dimmed nodes and edges when something is focused. */
export const DIMMED = "#e7e5e4";

export type GraphPalette = {
  /** Label glyph fill. */
  label: string;
  /** Halo stroked behind label glyphs — must match the page background. */
  halo: string;
  /** Baked into every edge attribute at build time. */
  edge: string;
  /** Sigma's defaultEdgeColor (edges without a color attr — rare here). */
  edgeSoft: string;
  /** Non-focused edges while something is focused. */
  edgeDim: string;
  /** Non-neighbor nodes while something is focused. */
  dimmed: string;
};

/**
 * The theme-dependent neutrals. Node colors (communities, hub types) read fine
 * on both themes and stay put; what has to flip is everything that assumes a
 * white page — label ink, the halo behind it, and the near-white edges that
 * vanish-into-black otherwise. Kept here beside the other graph colors so the
 * canvas and the legend can't drift.
 */
export function graphPalette(dark: boolean): GraphPalette {
  return dark
    ? {
        label: "#d6d3d1", // stone-300
        halo: "rgba(12,10,9,0.92)", // matches the dark background token
        edge: "#3f3c39",
        edgeSoft: "#35322f",
        edgeDim: "#292524", // stone-800
        dimmed: "#44403c", // stone-700
      }
    : {
        label: "#44403c", // stone-700
        halo: "rgba(255,255,255,0.92)",
        edge: "#e7e5e4", // stone-200
        edgeSoft: "#ededec",
        edgeDim: "#f5f5f4",
        dimmed: DIMMED,
      };
}
