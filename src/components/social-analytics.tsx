"use client";

import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ago } from "@/lib/format";
import type {
  DashboardPost,
  PlatformAnalytics,
  SocialDashboard,
  SocialNotes,
  YoutubeDay,
} from "@/lib/actions/social";
import type { SocialPlatform } from "@/db/schema";
import { PlatformMark, PlatformNote } from "@/components/social-view";

/**
 * The Analytics tab of /social: one section per platform — KPI tiles, a trend
 * chart, and the best recent posts. Charts are hand-rolled SVG like the
 * Sparkline (the app carries no charting library): single series each, one
 * hue via currentColor, a crosshair tooltip on hover.
 */

const LABELS: Record<SocialPlatform, string> = {
  linkedin: "LinkedIn",
  x: "X",
  youtube: "YouTube",
  instagram: "Instagram",
  github: "GitHub",
};

const EMPTY_HINT: Partial<Record<SocialPlatform, string>> = {
  linkedin: "No data yet — ask Claude Code to “sync social stats”.",
  x: "No data yet — add the four X keys in Settings → Setup.",
  youtube: "No data yet — add YouTube to your Google connection in Settings → Accounts.",
};

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : Intl.NumberFormat("en", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
const pct = (r: number | null) => (r == null ? "—" : `${(r * 100).toFixed(1)}%`);
const signed = (n: number | null) => (n == null ? null : `${n > 0 ? "+" : ""}${n.toLocaleString()}`);
const duration = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const shortDate = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en", { month: "short", day: "numeric" });

export function SocialAnalytics({
  dashboard,
  notes,
  onOpenPost,
}: {
  dashboard: SocialDashboard;
  notes: SocialNotes;
  onOpenPost: (id: number) => void;
}) {
  return (
    <div className="space-y-4 px-5 pb-10 pt-4">
      <Overview platforms={dashboard.platforms} />
      {dashboard.platforms.map((p) => (
        <PlatformSection
          key={p.platform}
          data={p}
          note={notes[p.platform] ?? ""}
          youtubeDaily={p.platform === "youtube" ? dashboard.youtubeDaily : []}
          onOpenPost={onOpenPost}
        />
      ))}
    </div>
  );
}

/** Total audience across platforms — the one number that sums sensibly. */
function Overview({ platforms }: { platforms: PlatformAnalytics[] }) {
  const withData = platforms.filter((p) => p.latest?.followers != null);
  if (withData.length === 0) return null;
  const total = withData.reduce((s, p) => s + (p.latest!.followers ?? 0), 0);
  const d30 = withData.some((p) => p.delta30 !== null)
    ? withData.reduce((s, p) => s + (p.delta30 ?? 0), 0)
    : null;
  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-3 rounded-lg border border-border px-4 py-3">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Total audience
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[28px] font-semibold leading-tight text-foreground">
            {total.toLocaleString()}
          </span>
          {d30 !== null && d30 !== 0 ? (
            <span className={cn("text-[12px] font-medium", d30 > 0 ? "text-emerald-600" : "text-rose-500")}>
              {signed(d30)} · 30d
            </span>
          ) : null}
        </div>
      </div>
      {withData.map((p) => (
        <div key={p.platform} className="flex items-center gap-1.5 pb-1">
          <PlatformMark platform={p.platform} className="size-3.5" />
          <span className="text-[13px] font-medium text-foreground">{fmt(p.latest!.followers)}</span>
        </div>
      ))}
    </div>
  );
}

type Kpi = { label: string; value: string; sub?: string | null; tone?: "up" | "down" | null };

function kpisFor(p: PlatformAnalytics): Kpi[] {
  const l = p.latest;
  const e = l?.extra ?? {};
  const followerSub = [signed(p.delta7) && `${signed(p.delta7)} 7d`, signed(p.delta30) && `${signed(p.delta30)} 30d`]
    .filter(Boolean)
    .join(" · ");
  const tone = p.delta30 == null || p.delta30 === 0 ? null : p.delta30 > 0 ? "up" : "down";
  const recentRate = p.window.impressions ? p.window.engagement / p.window.impressions : null;

  if (p.platform === "youtube") {
    const net = e.subsGained28d != null ? e.subsGained28d - (e.subsLost28d ?? 0) : null;
    return [
      { label: "Subscribers", value: fmt(l?.followers), sub: followerSub || null, tone },
      { label: "Views · 28d", value: fmt(e.views28d), sub: `${fmt(e.totalViews)} all time` },
      { label: "Watch time · 28d", value: e.watchMinutes28d != null ? `${fmt(Math.round(e.watchMinutes28d / 60))}h` : "—" },
      { label: "Avg view", value: e.avgViewSeconds28d != null ? duration(e.avgViewSeconds28d) : "—" },
      { label: "Net subs · 28d", value: signed(net) ?? "—", tone: net == null || net === 0 ? null : net > 0 ? "up" : "down" },
      { label: "Videos", value: fmt(l?.postCount) },
    ];
  }
  const out: Kpi[] = [{ label: "Followers", value: fmt(l?.followers), sub: followerSub || null, tone }];
  if (p.platform === "linkedin") {
    out.push({ label: "Profile views", value: fmt(l?.profileViews) });
    out.push({ label: "Impressions · 28d", value: fmt(l?.impressions) });
  }
  out.push({ label: "Posts · 90d", value: fmt(p.window.count), sub: p.recent.count ? `${p.recent.count} in last 30d` : null });
  out.push({ label: "Post views · 90d", value: fmt(p.window.impressions) });
  out.push({ label: "Engagement rate", value: pct(recentRate), sub: `${fmt(p.window.engagement)} interactions` });
  return out;
}

function PlatformSection({
  data,
  note,
  youtubeDaily,
  onOpenPost,
}: {
  data: PlatformAnalytics;
  note: string;
  youtubeDaily: YoutubeDay[];
  onOpenPost: (id: number) => void;
}) {
  const label = LABELS[data.platform];
  const followerPoints = data.series
    .filter((s) => s.followers !== null)
    .map((s) => ({ x: s.capturedAt, y: s.followers! }));
  const impressionPoints = data.series
    .filter((s) => s.impressions !== null)
    .map((s) => ({ x: s.capturedAt, y: s.impressions! }));

  return (
    <section className="rounded-lg border border-border">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <PlatformMark platform={data.platform} className="size-4" />
        <h2 className="text-[14px] font-semibold text-foreground">{label}</h2>
        {data.latest ? (
          <span suppressHydrationWarning className="text-[11px] text-muted-foreground">· updated {ago(data.latest.capturedAt)}</span>
        ) : null}
        <PlatformNote platform={data.platform} label={label} note={note} />
      </header>
      {note.trim() ? (
        <p className="line-clamp-2 border-b border-border px-4 py-2 text-[12px] leading-snug text-muted-foreground">
          {note}
        </p>
      ) : null}

      {!data.latest ? (
        <p className="px-4 py-4 text-[13px] text-muted-foreground">{EMPTY_HINT[data.platform]}</p>
      ) : (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {kpisFor(data).map((k) => (
              <div key={k.label} className="rounded-md bg-muted px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{k.label}</div>
                <div
                  className={cn(
                    "text-[17px] font-semibold",
                    k.tone === "up" ? "text-emerald-600" : k.tone === "down" ? "text-rose-500" : "text-foreground",
                  )}
                >
                  {k.value}
                </div>
                {k.sub ? <div className="truncate text-[10.5px] text-muted-foreground">{k.sub}</div> : null}
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {data.platform === "youtube" && youtubeDaily.length > 1 ? (
              <>
                <Chart title="Daily views" kind="bar" points={youtubeDaily.map((d) => ({ x: d.day, y: d.views }))} />
                <Chart
                  title="Daily watch time (hours)"
                  kind="bar"
                  points={youtubeDaily.map((d) => ({ x: d.day, y: Math.round((d.watchMinutes / 60) * 10) / 10 }))}
                />
              </>
            ) : null}
            <Chart
              title={data.platform === "youtube" ? "Subscribers" : "Followers"}
              kind="line"
              points={followerPoints}
            />
            {data.platform === "linkedin" && impressionPoints.length > 1 ? (
              <Chart title="Impressions (28-day rolling)" kind="line" points={impressionPoints} />
            ) : null}
          </div>

          <TopPosts posts={data.top} platform={data.platform} onOpenPost={onOpenPost} />
        </div>
      )}
    </section>
  );
}

/* ---------- chart ---------- */

type Pt = { x: string; y: number };

const W = 600;
const H = 160;
const PAD = { l: 44, r: 8, t: 8, b: 22 };

/** Round-number ticks from 0 (bars) or the data min (lines). */
function ticks(min: number, max: number): number[] {
  const span = max - min || Math.max(1, Math.abs(max));
  const step = 10 ** Math.floor(Math.log10(span / 2));
  const nice = [1, 2, 5, 10].map((m) => m * step).find((s) => span / s <= 4) ?? step * 10;
  const lo = Math.floor(min / nice) * nice;
  const out: number[] = [];
  for (let v = lo; v <= max + nice * 0.001; v += nice) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + nice);
  return out;
}

function Chart({ title, kind, points }: { title: string; kind: "line" | "bar"; points: Pt[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) {
    return (
      <figure className="rounded-md border border-dashed border-border p-3">
        <figcaption className="text-[12px] font-medium text-foreground">{title}</figcaption>
        <p className="pt-6 pb-8 text-center text-[12px] text-muted-foreground">
          Trend appears after a few captures.
        </p>
      </figure>
    );
  }

  const ys = points.map((p) => p.y);
  const t = ticks(kind === "bar" ? 0 : Math.min(...ys), Math.max(...ys));
  const yMin = t[0];
  const yMax = t[t.length - 1];
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const n = points.length;
  const band = iw / n;
  const x = (i: number) => (kind === "bar" ? PAD.l + band * (i + 0.5) : PAD.l + (i / (n - 1)) * iw);
  const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * ih;
  const barW = Math.max(1, band - 2);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = kind === "bar" ? Math.floor((px - PAD.l) / band) : Math.round(((px - PAD.l) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const h = hover !== null ? points[hover] : null;
  const last = points[n - 1];

  return (
    <figure className="relative rounded-md border border-border p-3">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-foreground">{title}</span>
        <span suppressHydrationWarning className="text-[11px] text-muted-foreground">
          {h ? `${shortDate(h.x)} · ${h.y.toLocaleString()}` : `${shortDate(last.x)} · ${last.y.toLocaleString()}`}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1 h-40 w-full text-violet-500"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${title}: ${points.length} points, latest ${last.y.toLocaleString()}`}
      >
        {t.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px]">
              {fmt(v)}
            </text>
          </g>
        ))}
        <text x={PAD.l} y={H - 4} className="fill-muted-foreground text-[10px]">
          {shortDate(points[0].x)}
        </text>
        <text x={W - PAD.r} y={H - 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
          {shortDate(last.x)}
        </text>

        {kind === "bar" ? (
          points.map((p, i) => (
            <rect
              key={p.x}
              x={x(i) - barW / 2}
              y={y(p.y)}
              width={barW}
              height={Math.max(0, y(yMin) - y(p.y))}
              rx={Math.min(2, barW / 2)}
              fill="currentColor"
              opacity={hover === null || hover === i ? 1 : 0.45}
            />
          ))
        ) : (
          <polyline
            points={points.map((p, i) => `${x(i)},${y(p.y)}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {h && hover !== null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} className="stroke-muted-foreground/50" strokeWidth={1} />
            {kind === "line" ? (
              <circle cx={x(hover)} cy={y(h.y)} r={4} fill="currentColor" className="stroke-background" strokeWidth={2} />
            ) : null}
          </g>
        ) : null}
      </svg>
    </figure>
  );
}

/* ---------- top posts ---------- */

function TopPosts({
  posts,
  platform,
  onOpenPost,
}: {
  posts: DashboardPost[];
  platform: SocialPlatform;
  onOpenPost: (id: number) => void;
}) {
  if (posts.length === 0) return null;
  const noun = platform === "youtube" ? "videos" : "posts";
  return (
    <div>
      <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Top {noun} · 90d
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[12.5px]">
          <thead>
            <tr className="text-left text-[11px] text-muted-foreground">
              <th className="w-[55%] py-1 pr-3 font-medium">{platform === "youtube" ? "Video" : "Post"}</th>
              <th className="py-1 pr-3 font-medium">Date</th>
              <th className="py-1 pr-3 text-right font-medium">Views</th>
              <th className="py-1 pr-3 text-right font-medium">Engagement</th>
              <th className="py-1 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.postUrl} className="border-t border-border">
                <td className="max-w-0 py-1.5 pr-3">
                  {p.postId !== null ? (
                    <button
                      type="button"
                      onClick={() => onOpenPost(p.postId!)}
                      className="block w-full truncate text-left text-foreground hover:underline"
                    >
                      {p.excerpt ?? p.postUrl}
                    </button>
                  ) : (
                    <a
                      href={p.postUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-foreground hover:underline"
                    >
                      <span className="truncate">{p.excerpt ?? p.postUrl}</span>
                      <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
                    </a>
                  )}
                </td>
                <td suppressHydrationWarning className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                  {p.postedAt ? shortDate(p.postedAt) : "—"}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(p.impressions)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(p.engagement)}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{pct(p.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
