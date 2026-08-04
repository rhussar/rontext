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
