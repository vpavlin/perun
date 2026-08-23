// Distance-along-route model shared by Replay mode's map, elevation strip and stats.
// The playhead position is a single number: cumulative distance in metres from the
// start. Both the map dot and the elevation marker are derived from it, so they stay
// in lockstep however you scrub. Distance is NOT accumulated across a `brk` (a paused
// gap), matching the elevation chart and analytics — the playhead simply doesn't
// advance during the gap.
import { GeoPoint } from "./types";
import { haversine } from "./analytics";

/** Cumulative distance (m) to each point; cum[0] = 0. Gaps (brk) add no distance. */
export function cumulativeDistances(points: GeoPoint[]): number[] {
  const cum = new Array(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    const step = points[i].brk
      ? 0
      : haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    cum[i] = cum[i - 1] + step;
  }
  return cum;
}

/** Total route distance (m). */
export function totalDistance(cum: number[]): number {
  return cum.length ? cum[cum.length - 1] : 0;
}

/** The point at cumulative distance `d` (m), linearly interpolated within its segment. */
export function pointAtDistance(points: GeoPoint[], cum: number[], d: number): GeoPoint | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0];
  const total = totalDistance(cum);
  const target = Math.max(0, Math.min(total, d));
  // Find the segment [i, i+1] containing target (cum is non-decreasing).
  let i = 0;
  while (i < cum.length - 1 && cum[i + 1] < target) i++;
  const a = points[i];
  const b = points[Math.min(i + 1, points.length - 1)];
  const segLen = cum[Math.min(i + 1, cum.length - 1)] - cum[i];
  const f = segLen > 0 ? (target - cum[i]) / segLen : 0;
  const lerp = (x: number, y: number) => x + (y - x) * f;
  const p: GeoPoint = { lat: lerp(a.lat, b.lat), lon: lerp(a.lon, b.lon), t: lerp(a.t, b.t) };
  if (a.alt != null && b.alt != null) p.alt = lerp(a.alt, b.alt);
  return p;
}

/** Index of the point nearest (in time) to journey-time `tMs` — how an annotation,
 *  pinned at a point's `t`, maps onto the distance axis. */
export function indexNearestTime(points: GeoPoint[], tMs: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i].t - tMs);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Cumulative distance (m) of the annotation pinned at journey-time `tMs`. */
export function distanceForTime(points: GeoPoint[], cum: number[], tMs: number): number {
  return cum[indexNearestTime(points, tMs)] ?? 0;
}
