"use client";

import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { DEFAULT_ZOOM, TILE_SIZE, worldPixel } from "@/lib/geo-tile";

const HEIGHT = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 16;

/**
 * CARTO's Voyager basemap rather than standard OSM tiles. Same OpenStreetMap
 * data underneath, but styled the way an embedded map wants to look — cool
 * greys, soft green parks, muted blue water — instead of OSM's saturated beige,
 * which no CSS filter can neutralise (a filter can desaturate a hue, not
 * replace it).
 *
 * @2x asks for 512px tiles rendered into a 256px box, so labels stay sharp on
 * retina displays.
 */
const SUBDOMAINS = ["a", "b", "c", "d"];
function tileUrl(zoom: number, x: number, y: number): string {
  const s = SUBDOMAINS[(x + y) % SUBDOMAINS.length];
  return `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/${zoom}/${x}/${y}@2x.png`;
}

export function LocationMap({
  latitude,
  longitude,
}: {
  latitude: number;
  longitude: number;
}) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  /**
   * The map fills whatever width the panel gives it, and the tile math needs
   * that number to keep the point centered — so it's measured rather than
   * assumed. This also means no tiles are requested while the About tab is
   * hidden (width 0); the observer fires with the real width once it opens.
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const zoomBy = (delta: number) =>
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta)));

  const { x, y } = worldPixel(latitude, longitude, zoom);

  // Viewport is centered on the point, so only the tiles overlapping this
  // window get requested.
  const left = x - width / 2;
  const top = y - HEIGHT / 2;
  const range = (start: number, span: number) => {
    const first = Math.floor(start / TILE_SIZE);
    const last = Math.floor((start + span - 1) / TILE_SIZE);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  };
  const n = 2 ** zoom;
  const wrap = (v: number) => ((v % n) + n) % n;

  return (
    <div
      ref={boxRef}
      // Focusable so +/- work here without hijacking those keys page-wide —
      // clicking the map focuses it, which is how Google Maps behaves too.
      tabIndex={0}
      role="group"
      aria-label="Location map. Press plus or minus to zoom."
      onKeyDown={(e) => {
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          zoomBy(1);
        } else if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          zoomBy(-1);
        }
      }}
      className="relative select-none overflow-hidden rounded-lg bg-stone-100 outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
      style={{ height: HEIGHT }}
    >
      {width > 0 ? (
        // pointer-events-none is what stops a click-drag from peeling a tile
        // off as a browser drag ghost. Nothing in here is interactive anyway.
        <div className="pointer-events-none absolute inset-0">
          {range(top, HEIGHT).map((ty) =>
            range(left, width).map((tx) => (
              // Plain <img>, not next/image: routing tiles through the image
              // pipeline would strip the Referer the tile host sees and bypass
              // the browser cache these tile policies expect.
              // No loading="lazy" either — it never fires for content created
              // inside a hidden tab, leaving the map permanently blank.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${zoom}-${tx}-${ty}`}
                src={tileUrl(zoom, wrap(tx), Math.min(Math.max(ty, 0), n - 1))}
                alt=""
                draggable={false}
                width={TILE_SIZE}
                height={TILE_SIZE}
                className="absolute max-w-none"
                style={{ left: tx * TILE_SIZE - left, top: ty * TILE_SIZE - top }}
              />
            )),
          )}
        </div>
      ) : null}

      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-rose-500 shadow"
      />

      <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-md border border-stone-200 bg-white shadow-sm">
        <ZoomButton
          label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => zoomBy(1)}
        >
          <Plus className="size-3.5" />
        </ZoomButton>
        <ZoomButton
          label="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          className="border-t border-stone-200"
          onClick={() => zoomBy(-1)}
        >
          <Minus className="size-3.5" />
        </ZoomButton>
      </div>

      {/* Both tile policies require visible credit — kept as a corner overlay
          rather than a footer bar, which is how Google carries its own. */}
      <a
        href={`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=${zoom}/${latitude}/${longitude}`}
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-0 right-0 rounded-tl bg-white/70 px-1 py-px text-[8.5px] leading-tight text-stone-400 transition-colors hover:text-stone-600"
      >
        © OpenStreetMap © CARTO
      </a>
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex size-6 items-center justify-center text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:opacity-30 disabled:hover:bg-transparent ${className ?? ""}`}
    >
      {children}
    </button>
  );
}
