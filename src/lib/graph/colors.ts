/**
 * Graph palette, company-only. Shared by the canvas build (build.ts), the
 * renderer, and the panel chrome so they can't drift.
 */

/**
 * Cluster accents. Hubs are ranked by member count and assigned round-robin,
 * so the twelve biggest companies each get a distinct hue and repeats only
 * happen among small, far-apart clusters. People inherit their primary
 * employer's accent — the cluster IS the company, so one color family per
 * cluster is the whole legend.
 */
export const COMPANY_COLORS = [
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
  /** Edges touching the focused node — the highlight color. */
  accent: string;
};

/**
 * The theme-dependent neutrals. Cluster accents read fine on both themes and
 * stay put; what has to flip is everything that assumes a white page — label
 * ink, the halo behind it, the near-white edges that vanish-into-black
 * otherwise, and the focus accent (600-weight blue disappears on black).
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
        accent: "#60a5fa", // blue-400
      }
    : {
        label: "#44403c", // stone-700
        halo: "rgba(255,255,255,0.92)",
        edge: "#e7e5e4", // stone-200
        edgeSoft: "#ededec",
        edgeDim: "#f5f5f4",
        dimmed: DIMMED,
        accent: "#2563eb", // blue-600
      };
}
