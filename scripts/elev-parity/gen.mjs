// deterministic track: gentle climb + jitter, drop, flat with bursts, a pause, points with no altitude
let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pts = []; let t = 1790000000000, lon = 14.39, lat = 50.1;
const push = (alt, brk) => { const p = { lat, lon, t }; if (alt != null) p.alt = Math.round(alt * 100) / 100; if (brk) p.brk = true; pts.push(p); t += 2000; lon += 0.00003; lat += 0.00001; };
for (let i = 0; i < 600; i++) push(i % 50 === 7 ? null : 245 + 40 * (i / 600) + (rnd() * 4 - 2));
for (let i = 0; i < 60; i++) push(285 - 52 * (i / 60));
t += 600000; push(233, true);
for (let i = 0; i < 600; i++) push((i % 9 < 3) ? 283 + rnd() * 4 : 233 + (rnd() * 3 - 1.5));
import { writeFileSync } from "fs"; writeFileSync("/tmp/claude-1000/track.json", JSON.stringify(pts));
import { computeSummary, computeSplits } from "/tmp/claude-1000/analytics.mjs";
const tr = { hasAlt: true, points: pts };
const s = computeSummary(tr); const sp = computeSplits(tr, 1000);
console.log("TS  gain", s.elevGainM.toFixed(4), "splits", sp.map(x => x.elevGainM.toFixed(4)).join(","));
