// Run analytics — TypeScript port of the module's run_analytics.h. Same
// haversine distance, pace, elevation gain, HR and per-km splits, so the phone
// and the Basecamp module compute identical numbers.
import { Track, RunSummary, Split, GeoPoint } from "./types";

const R = 6371000;
const D2R = Math.PI / 180;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// GPS/barometric altitude is noisy AND intermittent (a fix can arrive with no
// vertical component, so p.alt is undefined on some points). The old code did
// `(alt ?? 0) - (prevAlt ?? 0)`, which turned every missing-altitude gap into a
// phantom ±100 m swing and summed raw jitter on top — elevation gain came out
// wildly too high. This accumulator fixes both: it ignores samples with no
// altitude entirely, and only commits a rise once it clears a noise threshold
// measured from the last local trough (the standard way to score GPS ascent).
const ELEV_THRESHOLD_M = 5;
function makeElevAccumulator() {
  let ref: number | null = null; // last committed peak / running trough
  return {
    reset() { ref = null; }, // call across a break so a pause isn't bridged
    // Feed one sample; returns the metres of ascent to credit (0 unless a
    // sustained climb just cleared the threshold).
    add(alt: number | undefined): number {
      if (alt == null || !Number.isFinite(alt)) return 0;
      if (ref == null) { ref = alt; return 0; }
      const d = alt - ref;
      if (d >= ELEV_THRESHOLD_M) { ref = alt; return d; } // committed climb
      if (alt < ref) ref = alt; // new low — measure the next climb from here
      return 0;
    },
  };
}

export function computeSummary(tr: Track): RunSummary {
  const p = tr.points;
  const s: RunSummary = {
    distanceM: 0, durationS: 0, avgSpeedMps: 0, avgPaceSecPerKm: 0,
    elevGainM: 0, avgHr: 0, hasHr: !!tr.hasHr,
  };
  if (p.length < 2) return s;
  let hrSum = 0, hrN = 0;
  let movingMs = 0;
  const elev = makeElevAccumulator();
  if (tr.hasAlt) elev.add(p[0].alt); // seed the trough from the first fix
  for (let i = 1; i < p.length; i++) {
    // A break means the pair (i-1, i) spans a pause: no distance was covered
    // *by the activity*, and the wall time in between isn't moving time.
    // Skipping both is what makes pause honest.
    if (!p[i].brk) {
      s.distanceM += haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon);
      movingMs += p[i].t - p[i - 1].t;
      if (tr.hasAlt) s.elevGainM += elev.add(p[i].alt);
    } else if (tr.hasAlt) {
      elev.reset(); // don't bridge an ascent across a pause/teleport
    }
    if (tr.hasHr) { hrSum += p[i].hr ?? 0; hrN++; }
  }
  // Sum of per-step deltas, not last-minus-first: with no breaks the two are
  // identical, so unpaused runs are unaffected.
  s.durationS = movingMs / 1000;
  if (s.durationS > 0) s.avgSpeedMps = s.distanceM / s.durationS;
  if (s.distanceM > 0) s.avgPaceSecPerKm = s.durationS / (s.distanceM / 1000);
  if (hrN) s.avgHr = hrSum / hrN;
  return s;
}

export function computeSplits(tr: Track, splitMeters = 1000): Split[] {
  const p = tr.points;
  const splits: Split[] = [];
  if (p.length < 2) return splits;
  let idx = 1, splitDist = 0, splitElev = 0, hrSum = 0, hrN = 0;
  // Accumulate moving time so a pause mid-kilometre doesn't inflate that split's
  // pace (elapsed time would make a coffee stop look like a collapse).
  let splitMs = 0;
  // One accumulator for the whole track (so the trough reference carries across
  // km boundaries); committed ascent lands in whichever split it happened in.
  const elev = makeElevAccumulator();
  if (tr.hasAlt) elev.add(p[0].alt);
  const close = () => {
    const dur = splitMs / 1000;
    splits.push({
      index: idx++,
      distanceM: splitDist,
      durationS: dur,
      elevGainM: splitElev,
      avgHr: hrN ? hrSum / hrN : 0,
      paceSecPerKm: splitDist > 0 ? dur / (splitDist / 1000) : 0,
    });
  };
  for (let i = 1; i < p.length; i++) {
    if (!p[i].brk) {
      splitDist += haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon);
      splitMs += p[i].t - p[i - 1].t;
      if (tr.hasAlt) splitElev += elev.add(p[i].alt);
    } else if (tr.hasAlt) {
      elev.reset();
    }
    if (tr.hasHr) { hrSum += p[i].hr ?? 0; hrN++; }
    if (splitDist >= splitMeters) {
      close();
      splitDist = 0; splitElev = 0; hrSum = 0; hrN = 0; splitMs = 0;
    }
  }
  if (splitDist > 1) close();
  return splits;
}

/**
 * The tail of a track covering roughly the last `meters` of travelled distance —
 * used to build a "follow" (zoomed-in) map crop around the current location while
 * the full polyline is still drawn from all points. Walks backwards accumulating
 * segment lengths (breaks don't add distance) until the budget is spent. Always
 * returns >=2 points when the track has them, so buildLayout can fit a viewport.
 */
export function tailByDistance(points: GeoPoint[], meters: number): GeoPoint[] {
  if (points.length < 2) return points;
  const out: GeoPoint[] = [points[points.length - 1]];
  let acc = 0;
  for (let i = points.length - 1; i > 0; i--) {
    out.push(points[i - 1]);
    if (!points[i].brk) {
      acc += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }
    if (acc >= meters) break;
  }
  return out.reverse();
}

// ---- formatting helpers (match the QML view) ----
export const fmtDist = (m: number) => ((m || 0) / 1000).toFixed(2) + " km";
export const fmtPace = (s: number) => {
  if (!s || s <= 0) return "—";
  const mm = Math.floor(s / 60), ss = Math.round(s % 60);
  return `${mm}:${ss < 10 ? "0" + ss : ss} /km`;
};
export const fmtDur = (s: number) => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = m < 10 ? "0" + m : m, ss = sec < 10 ? "0" + sec : sec;
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};
export const fmtElev = (m: number) => Math.round(m || 0) + " m";

/** Speed in km/h — what you want for cycling (pace min/km is a runner's unit). */
export const fmtSpeed = (secPerKm: number) => {
  if (!secPerKm || secPerKm <= 0) return "—";
  return (3600 / secPerKm).toFixed(1) + " km/h";
};

/** Foot sports read pace; wheeled sports read speed. */
export const fmtRate = (secPerKm: number, foot: boolean) =>
  foot ? fmtPace(secPerKm) : fmtSpeed(secPerKm);
export const rateLabel = (foot: boolean) => (foot ? "Pace" : "Speed");

// ---- week grouping -----------------------------------------------------------
// Training is judged by the week, not the run: a flat reverse-chronological list
// can't answer "have I done enough this week?", which is the question people
// actually open a tracker to ask.

/** Local Monday 00:00 of the week containing ts. */
export function weekStart(ts: number): number {
  const d = new Date(ts || 0);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // getDay: Sun=0 → Mon=0
  return d.getTime();
}

/** Shift by whole days via the Date API, never ts − n*864e5: across a DST change
 *  a fixed-millisecond week is off by an hour and lands in the wrong week. */
const addDays = (ts: number, n: number) => {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
};

export function fmtWeek(ws: number, now = Date.now()): string {
  const cur = weekStart(now);
  if (ws === cur) return "This week";
  if (ws === weekStart(addDays(cur, -7))) return "Last week";
  const a = new Date(ws), b = new Date(addDays(ws, 6));
  const mon = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${mon(b)}`
    : `${a.getDate()} ${mon(a)} – ${b.getDate()} ${mon(b)}`;
}

export interface WeekSection<T> {
  weekStart: number;
  title: string;
  distanceM: number;
  durationS: number;
  data: T[];
}

/** Group runs (newest-first) into newest-first week sections with totals. */
export function groupByWeek<T extends { startTs: number; summary: RunSummary }>(
  runs: T[],
  now = Date.now()
): WeekSection<T>[] {
  const byWeek = new Map<number, T[]>();
  for (const r of runs) {
    const k = weekStart(r.startTs);
    const arr = byWeek.get(k);
    if (arr) arr.push(r);
    else byWeek.set(k, [r]);
  }
  return [...byWeek.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([ws, data]) => ({
      weekStart: ws,
      title: fmtWeek(ws, now),
      distanceM: data.reduce((s, r) => s + (r.summary?.distanceM ?? 0), 0),
      durationS: data.reduce((s, r) => s + (r.summary?.durationS ?? 0), 0),
      data: data.slice().sort((a, b) => b.startTs - a.startTs),
    }));
}

/** Run-list dates. The list currently shows none — startTs was stored, never shown. */
export const fmtDate = (ts: number) => {
  const d = new Date(ts || 0);
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time}`;
};
