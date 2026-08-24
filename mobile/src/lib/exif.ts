// Place a photo annotation from the photo's own EXIF metadata, when it has any.
//
// A photo taken during a run knows where and when it was shot. We prefer that over the
// composer/playhead point so a library photo added after the fact lands at the right spot:
//   1. EXIF timestamp within the run's time window -> the track point at that moment
//      (strongest: gives an on-route position AND the correct journey time `t`).
//   2. else EXIF GPS -> the nearest track point, but only if it's actually near the route
//      (guarded, so an unrelated photo doesn't snap to a random point).
//   3. else null -> caller falls back to the point it already had.
import { GeoPoint } from "./types";
import { haversine } from "./analytics";
import { indexNearestTime } from "./route";

// expo-image-picker returns EXIF as a loosely-typed object; keys vary by platform
// (flat GPSLatitude/… on Android, sometimes nested under "{GPS}" on iOS).
type Exif = Record<string, unknown> | null | undefined;

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && isFinite(n) ? n : null;
};

/** Signed lat/lon from EXIF GPS tags, or null. Applies N/S · E/W refs when present. */
export function parseExifGps(exif: Exif): { lat: number; lon: number } | null {
  if (!exif) return null;
  const g = ((exif["{GPS}"] as Record<string, unknown>) || (exif.GPS as Record<string, unknown>) || exif) as Record<string, unknown>;
  let lat = num(g.GPSLatitude ?? g.Latitude);
  let lon = num(g.GPSLongitude ?? g.Longitude);
  if (lat == null || lon == null) return null;
  if (lat === 0 && lon === 0) return null; // "no fix" sentinel
  const latRef = String(g.GPSLatitudeRef ?? g.LatitudeRef ?? "").toUpperCase();
  const lonRef = String(g.GPSLongitudeRef ?? g.LongitudeRef ?? "").toUpperCase();
  // Only apply a ref when it's present; a value that's already signed carries no ref.
  if (latRef) lat = Math.abs(lat) * (latRef === "S" ? -1 : 1);
  if (lonRef) lon = Math.abs(lon) * (lonRef === "W" ? -1 : 1);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Epoch ms from EXIF DateTimeOriginal ("YYYY:MM:DD HH:MM:SS", local time), or null. */
export function parseExifTime(exif: Exif): number | null {
  if (!exif) return null;
  const s = exif.DateTimeOriginal ?? exif.DateTimeDigitized ?? exif.DateTime;
  if (!s) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); // EXIF has no tz → local
  const ms = d.getTime();
  return isFinite(ms) ? ms : null;
}

const NEAR_ROUTE_M = 250; // GPS must be within this of the route to be "on this run"
const TIME_PAD_MS = 5 * 60 * 1000; // allow a few minutes either side of the run window

/**
 * The track point a photo should pin to, derived from its EXIF, or null if the EXIF has no
 * usable geodata (or the photo isn't from this run). Callers fall back to their own point.
 */
export function photoPointFromExif(exif: Exif, points: GeoPoint[]): GeoPoint | null {
  if (!exif || !points || points.length < 1) return null;

  // 1) Timestamp within the run window → the point at that moment.
  const t = parseExifTime(exif);
  if (t != null) {
    const t0 = points[0].t;
    const tN = points[points.length - 1].t;
    if (t >= t0 - TIME_PAD_MS && t <= tN + TIME_PAD_MS) {
      return points[indexNearestTime(points, t)];
    }
  }

  // 2) GPS near the route → the nearest point (guarded).
  const gps = parseExifGps(exif);
  if (gps) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = haversine(points[i].lat, points[i].lon, gps.lat, gps.lon);
      if (d < bd) { bd = d; best = i; }
    }
    if (bd <= NEAR_ROUTE_M) return points[best];
  }

  return null;
}
