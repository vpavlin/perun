// OSM raster basemap: Web Mercator (EPSG:3857) slippy-map math plus a disk tile
// cache under Paths.cache. Tiles are fetched at most once, with a real
// User-Agent and a capped zoom, per the OSM tile usage policy:
// https://operations.osmfoundation.org/policies/tiles/
// Callers must render the "© OpenStreetMap contributors" attribution whenever a
// tile is actually drawn.
import { Directory, File, Paths } from "expo-file-system";
import { GeoPoint } from "./types";

export const TILE_SIZE = 256;
/** OSM policy: keep zoom sane. z16 (~2 m/px) is more than enough for a run. */
export const MAX_ZOOM = 16;

const UA = "Perun/1.2 (+https://github.com/vpavlin/perun)";
const tileUrl = (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

/** lon → normalised Mercator X in [0,1]. */
export const mercX = (lon: number) => (lon + 180) / 360;

/** lat → normalised Mercator Y in [0,1], 0 = north. Clamped to the Mercator limit. */
export function mercY(lat: number) {
  const c = Math.min(85.05112878, Math.max(-85.05112878, lat));
  const r = (c * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

export interface TileRef {
  /** React key — unwrapped grid slot, unique within a layout. */
  key: string;
  /** Cache key — wrapped x, so one tile is fetched once. */
  id: string;
  z: number;
  x: number;
  y: number;
  /** Top-left of the tile in SVG coordinates. */
  sx: number;
  sy: number;
}

export interface MapLayout {
  z: number;
  tiles: TileRef[];
  /** Identity of the tile set — memoise fetching on this, never on `points`. */
  key: string;
  /** lon/lat → SVG px, the same Mercator transform that places the tiles. */
  project: (p: GeoPoint) => [number, number];
}

/**
 * Fit the track's bbox into width×height and derive the covering tile grid.
 * Everything (tiles and track) goes through the same Mercator transform, so the
 * polyline lines up with the basemap.
 */
export function buildLayout(points: GeoPoint[], width: number, height: number): MapLayout | null {
  if (!points || points.length < 2 || width <= 0 || height <= 0) return null;

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of points) {
    const mx = mercX(p.lon), my = mercY(p.lat);
    if (mx < x0) x0 = mx;
    if (mx > x1) x1 = mx;
    if (my < y0) y0 = my;
    if (my > y1) y1 = my;
  }
  if (!isFinite(x0) || !isFinite(y0)) return null;

  const m = 12; // padding so the track never touches the edge
  const availW = Math.max(1, width - 2 * m), availH = Math.max(1, height - 2 * m);
  // Guard a degenerate span (all points identical / one axis flat): the fit then
  // wants infinite zoom and simply clamps to MAX_ZOOM.
  const spanX = Math.max(1e-12, x1 - x0), spanY = Math.max(1e-12, y1 - y0);
  const fit = Math.min(availW / (spanX * TILE_SIZE), availH / (spanY * TILE_SIZE));
  const z = Math.max(0, Math.min(MAX_ZOOM, Math.floor(Math.log2(fit))));

  const scale = TILE_SIZE * Math.pow(2, z); // SVG px per normalised Mercator unit
  // Screen position of Mercator (0,0), with the track's bbox centred in the box.
  const originX = (width - spanX * scale) / 2 - x0 * scale;
  const originY = (height - spanY * scale) / 2 - y0 * scale;

  // Tile t spans world px [t*256, (t+1)*256), so screen x = originX + t*256.
  const n = 1 << z;
  const tx0 = Math.floor(-originX / TILE_SIZE), tx1 = Math.floor((width - originX) / TILE_SIZE);
  const ty0 = Math.floor(-originY / TILE_SIZE), ty1 = Math.floor((height - originY) / TILE_SIZE);
  const tiles: TileRef[] = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= n) continue; // past the Mercator poles — no tile exists
      const wx = ((tx % n) + n) % n; // wrap at the antimeridian
      tiles.push({
        key: `${z}/${tx}/${ty}`,
        id: `${z}/${wx}/${ty}`,
        z,
        x: wx,
        y: ty,
        sx: originX + tx * TILE_SIZE,
        sy: originY + ty * TILE_SIZE,
      });
    }
  }

  return {
    z,
    tiles,
    key: `${z}:${tx0}:${tx1}:${ty0}:${ty1}`,
    project: (p) => [originX + mercX(p.lon) * scale, originY + mercY(p.lat) * scale],
  };
}

let dir: Directory | null = null;
function cacheDir(): Directory | null {
  if (dir) return dir;
  try {
    const d = new Directory(Paths.cache, "osm-tiles");
    d.create({ intermediates: true, idempotent: true });
    dir = d;
    return d;
  } catch {
    return null;
  }
}

const resolved = new Map<string, string>(); // tile id → file:// uri
const inflight = new Map<string, Promise<string | null>>();

/**
 * file:// URI for a tile, from disk if we have it, else fetched once and cached.
 * Resolves to null when the tile can't be had (offline, HTTP error, no storage)
 * — callers fall back to the plain background rather than failing.
 */
export function getTile(z: number, x: number, y: number): Promise<string | null> {
  const id = `${z}/${x}/${y}`;
  const hit = resolved.get(id);
  if (hit) return Promise.resolve(hit);
  const busy = inflight.get(id);
  if (busy) return busy;
  const p = fetchTile(z, x, y, id).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function fetchTile(z: number, x: number, y: number, id: string): Promise<string | null> {
  const d = cacheDir();
  if (!d) return null;
  const name = `${z}_${x}_${y}.png`;
  try {
    const f = new File(d, name);
    if (f.exists) {
      resolved.set(id, f.uri);
      return f.uri;
    }
    const out = await File.downloadFileAsync(tileUrl(z, x, y), f, {
      headers: { "User-Agent": UA },
      idempotent: true,
    });
    resolved.set(id, out.uri);
    return out.uri;
  } catch {
    // Android streams the body straight into the destination, so a download that
    // dies mid-flight leaves a truncated file that would otherwise be cached and
    // served forever. Drop it.
    try {
      const f = new File(d, name);
      if (f.exists) f.delete();
    } catch {}
    return null;
  }
}
