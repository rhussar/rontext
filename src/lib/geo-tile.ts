const TILE_SIZE = 256;

/**
 * Starting zoom for the location map — the user can step in or out from here.
 * Deliberately wide: this answers "roughly where in the world is this person"
 * at a glance, and anything tighter kept framing contacts too close to read
 * as an orientation. It also stays honest for a coarse "New York, United
 * States" match, where a city-level frame would imply precision we don't have.
 */
export const DEFAULT_ZOOM = 6;

/** Slippy-map longitude → tile X (Web Mercator / EPSG:3857). */
export function lonToTileX(lonDeg: number, zoom: number): number {
  return Math.floor(((lonDeg + 180) / 360) * 2 ** zoom);
}

/** Slippy-map latitude → tile Y (Web Mercator / EPSG:3857). */
export function latToTileY(latDeg: number, zoom: number): number {
  const latRad = (latDeg * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** zoom,
  );
}

export function osmTileUrl(latDeg: number, lonDeg: number, zoom = DEFAULT_ZOOM): string {
  const n = 2 ** zoom;
  const x = ((lonToTileX(lonDeg, zoom) % n) + n) % n; // wrap the antimeridian
  const y = Math.min(Math.max(latToTileY(latDeg, zoom), 0), n - 1); // clamp the poles
  return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
}

/**
 * Absolute pixel position on the whole-world map at this zoom. Tile indices only
 * say which 256×256 square holds the point; this says exactly where, which is
 * what lets the view center on the location rather than on a tile boundary.
 */
export function worldPixel(
  latDeg: number,
  lonDeg: number,
  zoom = DEFAULT_ZOOM,
): { x: number; y: number } {
  const n = 2 ** zoom;
  const latRad = (latDeg * Math.PI) / 180;
  return {
    x: ((lonDeg + 180) / 360) * n * TILE_SIZE,
    y:
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n *
      TILE_SIZE,
  };
}

export { TILE_SIZE };
