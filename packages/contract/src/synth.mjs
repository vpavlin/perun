// Deterministic synthetic run generator (no Math.random — reproducible) for
// benchmarks and the fake-run CLI. Simulates a runner near Brno at ~3 m/s with
// GPS jitter, gentle elevation wander, and drifting HR.
let seed = 1337;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

export function resetSeed(s = 1337) { seed = s; }

export function synthRun(durationS, hz = 1) {
  const n = Math.floor(durationS * hz);
  const pts = [];
  let lat = 49.1951, lon = 16.6068, alt = 250, hr = 120, t = 1_752_000_000_000;
  const mPerDegLat = 111_320, mPerDegLon = 111_320 * Math.cos(lat * Math.PI / 180);
  let heading = 0;
  for (let i = 0; i < n; i++) {
    heading += (rnd() - 0.5) * 0.3;
    const speed = 2.8 + rnd() * 0.8;
    const dist = speed / hz;
    lat += (dist * Math.cos(heading)) / mPerDegLat;
    lon += (dist * Math.sin(heading)) / mPerDegLon;
    alt += (rnd() - 0.5) * 0.8;
    hr = Math.min(185, hr + (rnd() - 0.45) * 0.5);
    pts.push({ lat, lon, alt, speed, hr: Math.round(hr), t });
    t += Math.round(1000 / hz);
  }
  return pts;
}
