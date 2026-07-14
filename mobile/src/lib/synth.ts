// Synthetic run generator — TS port of the module's makeSyntheticTrack. Used
// to exercise the app before real GPS capture (expo-location) is wired in.
import { Track, GeoPoint } from "./types";

export function synthRun(seconds = 1200, hz = 1): Track {
  let lat = 49.1951, lon = 16.6068, alt = 250, hr = 120, heading = 0;
  let t = Date.now();
  const mLat = 111320, mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  let seed = (t ^ 0x9e3779b9) >>> 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return ((seed >>> 16) & 0x7fff) / 32767; };
  const points: GeoPoint[] = [];
  const n = seconds * hz;
  for (let i = 0; i < n; i++) {
    heading += (rnd() - 0.5) * 0.3;
    const speed = 2.8 + rnd() * 0.8;
    lat += ((speed / hz) * Math.cos(heading)) / mLat;
    lon += ((speed / hz) * Math.sin(heading)) / mLon;
    alt += (rnd() - 0.5) * 0.8;
    hr = Math.min(185, hr + (rnd() - 0.45) * 0.5);
    points.push({ lat, lon, alt, hr: Math.round(hr), speed, t });
    t += Math.round(1000 / hz);
  }
  return { name: "Morning run", hasAlt: true, hasHr: true, points };
}
