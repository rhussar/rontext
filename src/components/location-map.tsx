import { DEFAULT_ZOOM, TILE_SIZE, worldPixel } from "@/lib/geo-tile";

const VIEW = 256;

export function LocationMap({
  latitude,
  longitude,
}: {
  latitude: number;
  longitude: number;
}) {
  const zoom = DEFAULT_ZOOM;
  const { x, y } = worldPixel(latitude, longitude, zoom);

  // Viewport is centered on the point, so only the tiles overlapping this
  // window get requested — at most two per axis.
  const left = x - VIEW / 2;
  const top = y - VIEW / 2;
  const range = (start: number) => {
    const first = Math.floor(start / TILE_SIZE);
    const last = Math.floor((start + VIEW - 1) / TILE_SIZE);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  };
  const n = 2 ** zoom;
  const wrap = (v: number) => ((v % n) + n) % n;

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200">
      <div
        className="relative mx-auto overflow-hidden bg-stone-100"
        style={{ width: VIEW, height: VIEW, maxWidth: "100%" }}
      >
        {range(top).map((ty) =>
          range(left).map((tx) => (
            // Plain <img>, not next/image: routing tiles through the image
            // pipeline would strip the Referer that identifies this app to OSM
            // and bypass the browser cache their tile policy expects.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${tx}-${ty}`}
              src={`https://tile.openstreetmap.org/${zoom}/${wrap(tx)}/${Math.min(Math.max(ty, 0), n - 1)}.png`}
              alt=""
              width={TILE_SIZE}
              height={TILE_SIZE}
              className="absolute max-w-none"
              style={{ left: tx * TILE_SIZE - left, top: ty * TILE_SIZE - top }}
            />
          )),
        )}
        <span
          aria-hidden
          className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-rose-500 shadow"
        />
      </div>
      <a
        href={`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=${zoom}/${latitude}/${longitude}`}
        target="_blank"
        rel="noreferrer"
        className="block bg-stone-50 px-2 py-1 text-center text-[10px] text-stone-400 transition-colors hover:text-stone-600"
      >
        © OpenStreetMap contributors
      </a>
    </div>
  );
}
