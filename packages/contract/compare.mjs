// Compare on-the-wire size: compact codec vs GPX (raw + gzipped), and how many
// 150 KB Delivery messages each needs. Run: node compare.mjs
import { gzipSync } from "node:zlib";
import { encodeTrack } from "./src/track-codec.mjs";
import { synthRun } from "./src/synth.mjs";
import { base64Len, WAKU_MAX_BYTES } from "./src/messages.mjs";

// Realistic GPX 1.1 with Garmin HR extension (what Strava/Garmin actually emit).
function toGPX(pts) {
  const head =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Perun" xmlns="http://www.topografix.com/GPX/1/1" ` +
    `xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n<trk><name>Run</name><trkseg>\n`;
  const body = pts.map(p => {
    const t = new Date(p.t).toISOString();
    return `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
      `<ele>${p.alt.toFixed(1)}</ele><time>${t}</time>` +
      `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${p.hr}</gpxtpx:hr>` +
      `</gpxtpx:TrackPointExtension></extensions></trkpt>\n`;
  }).join("");
  return head + body + `</trkseg></trk></gpx>\n`;
}

const msgs = raw => Math.max(1, Math.ceil(base64Len(raw) / WAKU_MAX_BYTES));
const kb = n => (n / 1024).toFixed(0);

const cases = [
  ["30 min @1Hz", 1800], ["1 h @1Hz", 3600], ["2 h @1Hz", 7200],
  ["marathon ~3.5h", 12600], ["100k ultra ~10h", 36000],
];

console.log("case              pts |  compact  msgs | gpx(raw) | gpx.gz  msgs | gz vs compact");
console.log("─".repeat(84));
for (const [name, dur] of cases) {
  const pts = synthRun(dur, 1);
  const compact = encodeTrack(pts, { alt: true, hr: true, speed: true }).length;
  const gpxRaw = Buffer.byteLength(toGPX(pts), "utf8");
  const gpxGz = gzipSync(toGPX(pts)).length;
  console.log(
    name.padEnd(16),
    String(pts.length).padStart(5),
    "|", (kb(compact) + "K").padStart(7), String(msgs(compact)).padStart(4),
    "|", (kb(gpxRaw) + "K").padStart(7),
    "|", (kb(gpxGz) + "K").padStart(6), String(msgs(gpxGz)).padStart(4),
    "|", (gpxGz / compact).toFixed(1) + "x bigger"
  );
}
