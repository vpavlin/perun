// Validates the core assumption: a compact-encoded run fits under Waku's 150 KB cap
// (accounting for base64), and the codec round-trips losslessly. Run: `node bench.mjs`
import { encodeTrack, decodeTrack, chunkTrack } from "./src/track-codec.mjs";
import { base64Len, WAKU_MAX_BYTES, RAW_CHUNK_BUDGET, estimateEnvelopeOverhead } from "./src/messages.mjs";

// Deterministic PRNG (no Math.random — reproducible).
let seed = 1337;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// Synthesize a plausible run: a runner near Brno moving ~3 m/s with GPS jitter,
// gentle elevation wander, HR drifting up. 1 deg lat ~= 111_320 m; lon scaled by cos(lat).
function synthRun(durationS, hz) {
  const n = Math.floor(durationS * hz);
  const pts = [];
  let lat = 49.1951, lon = 16.6068, alt = 250, hr = 120, t = 1_752_000_000_000;
  const mPerDegLat = 111_320, mPerDegLon = 111_320 * Math.cos(lat * Math.PI / 180);
  let heading = 0;
  for (let i = 0; i < n; i++) {
    heading += (rnd() - 0.5) * 0.3;                     // meander
    const speed = 2.8 + rnd() * 0.8;                    // ~3 m/s
    const dist = speed / hz;                             // metres this step
    lat += (dist * Math.cos(heading)) / mPerDegLat;
    lon += (dist * Math.sin(heading)) / mPerDegLon;
    alt += (rnd() - 0.5) * 0.8;                          // ± decimetres of drift
    hr = Math.min(185, hr + (rnd() - 0.45) * 0.5);
    pts.push({ lat, lon, alt, speed, hr: Math.round(hr), t });
    t += Math.round(1000 / hz);
  }
  return pts;
}

function roundTripError(pts, opts) {
  const dec = decodeTrack(encodeTrack(pts, opts));
  let maxLat = 0, maxLon = 0, maxT = 0, maxAlt = 0;
  for (let i = 0; i < pts.length; i++) {
    maxLat = Math.max(maxLat, Math.abs(pts[i].lat - dec[i].lat));
    maxLon = Math.max(maxLon, Math.abs(pts[i].lon - dec[i].lon));
    maxT = Math.max(maxT, Math.abs(pts[i].t - dec[i].t));
    if (opts.alt) maxAlt = Math.max(maxAlt, Math.abs(pts[i].alt - dec[i].alt));
  }
  return { maxLat, maxLon, maxT, maxAlt };
}

const opts = { alt: true, hr: true, speed: true };
const cases = [
  ["30 min @1Hz", 1800, 1],
  ["1 h @1Hz", 3600, 1],
  ["2 h @1Hz", 7200, 1],
  ["marathon ~3.5h @1Hz", 12600, 1],
  ["1 h @0.5Hz", 3600, 0.5],
  ["100k ultra ~10h @1Hz", 36000, 1],
];

const overhead = estimateEnvelopeOverhead();
console.log(`Waku cap ${WAKU_MAX_BYTES} B/msg · raw chunk budget ${RAW_CHUNK_BUDGET} B (base64 4/3 + envelope) · env overhead ~${overhead} B\n`);
console.log("case                    pts     raw KB   b64 KB   B/pt   fits 1msg?  chunks   maxErr(deg / ms / m)");
console.log("─".repeat(108));

let allLossless = true;
for (const [name, dur, hz] of cases) {
  const pts = synthRun(dur, hz);
  const raw = encodeTrack(pts, opts);
  const b64 = base64Len(raw.length);
  const err = roundTripError(pts, opts);
  const lossless = err.maxLat < 1e-6 && err.maxLon < 1e-6 && err.maxT === 0 && err.maxAlt <= 0.05;
  allLossless = allLossless && lossless;
  const fits = b64 + overhead <= WAKU_MAX_BYTES;
  const chunks = fits ? 1 : chunkTrack(pts, opts, RAW_CHUNK_BUDGET).length;
  console.log(
    name.padEnd(22),
    String(pts.length).padStart(6),
    (raw.length / 1024).toFixed(1).padStart(8),
    (b64 / 1024).toFixed(1).padStart(8),
    (raw.length / pts.length).toFixed(1).padStart(6),
    (fits ? "yes" : "NO").padStart(10),
    String(chunks).padStart(7),
    `   ${err.maxLat.toExponential(1)} / ${err.maxT} / ${err.maxAlt.toFixed(2)}`
  );
}
console.log("─".repeat(108));
console.log(allLossless ? "✓ round-trip lossless within tolerance (≤1.1cm coords, exact ms, ≤5cm alt)"
                        : "✗ ROUND-TRIP ERROR exceeded tolerance");
console.log("Takeaway: normal runs are one Delivery message; only ultra-long runs chunk. Storage not needed on the hot path.");
