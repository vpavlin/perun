// Run analytics — TypeScript port of the module's run_analytics.h. Same
// haversine distance, pace, elevation gain, HR and per-km splits, so the phone
// and the Basecamp module compute identical numbers.
import { Track, RunSummary, Split } from "./types";

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

export function computeSummary(tr: Track): RunSummary {
  const p = tr.points;
  const s: RunSummary = {
    distanceM: 0, durationS: 0, avgSpeedMps: 0, avgPaceSecPerKm: 0,
    elevGainM: 0, avgHr: 0, hasHr: !!tr.hasHr,
  };
  if (p.length < 2) return s;
  let hrSum = 0, hrN = 0;
  for (let i = 1; i < p.length; i++) {
    s.distanceM += haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon);
    if (tr.hasAlt) {
      const d = (p[i].alt ?? 0) - (p[i - 1].alt ?? 0);
      if (d > 0) s.elevGainM += d;
    }
    if (tr.hasHr) { hrSum += p[i].hr ?? 0; hrN++; }
  }
  s.durationS = (p[p.length - 1].t - p[0].t) / 1000;
  if (s.durationS > 0) s.avgSpeedMps = s.distanceM / s.durationS;
  if (s.distanceM > 0) s.avgPaceSecPerKm = s.durationS / (s.distanceM / 1000);
  if (hrN) s.avgHr = hrSum / hrN;
  return s;
}

export function computeSplits(tr: Track, splitMeters = 1000): Split[] {
  const p = tr.points;
  const splits: Split[] = [];
  if (p.length < 2) return splits;
  let idx = 1, splitDist = 0, splitElev = 0, hrSum = 0, hrN = 0, startT = p[0].t;
  const close = (endT: number) => {
    const dur = (endT - startT) / 1000;
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
    splitDist += haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon);
    if (tr.hasAlt) {
      const d = (p[i].alt ?? 0) - (p[i - 1].alt ?? 0);
      if (d > 0) splitElev += d;
    }
    if (tr.hasHr) { hrSum += p[i].hr ?? 0; hrN++; }
    if (splitDist >= splitMeters) {
      close(p[i].t);
      startT = p[i].t; splitDist = 0; splitElev = 0; hrSum = 0; hrN = 0;
    }
  }
  if (splitDist > 1) close(p[p.length - 1].t);
  return splits;
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
