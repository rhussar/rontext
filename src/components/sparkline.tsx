/**
 * Tiny inline-SVG line chart — the app deliberately has no charting library
 * (the only precedents are the settings Stat tile and sigma's canvas). Color
 * comes from `currentColor`, so a Tailwind text class themes it and dark mode
 * works for free.
 */
export function Sparkline({
  values,
  className,
}: {
  /** Oldest first. Nulls are skipped; fewer than 2 real points renders nothing. */
  values: (number | null)[];
  className?: string;
}) {
  const points = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v !== null);
  if (points.length < 2) return null;

  const W = 100;
  const H = 28;
  const PAD = 2;
  const min = Math.min(...points.map((p) => p.v));
  const max = Math.max(...points.map((p) => p.v));
  const spanX = points[points.length - 1].i - points[0].i || 1;
  // A flat series still draws — centered — rather than dividing by zero.
  const spanY = max - min || 1;
  const coords = points
    .map((p) => {
      const x = PAD + ((p.i - points[0].i) / spanX) * (W - PAD * 2);
      const y =
        max === min
          ? H / 2
          : PAD + (1 - (p.v - min) / spanY) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
    >
      <polyline
        points={coords}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
