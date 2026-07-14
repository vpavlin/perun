// GPX 1.1 (Garmin HR extension) <-> Track — TS port of the module's gpx.h.
// This is the interchange format the phone sends over Delivery (gzipped) and
// what Garmin/Strava import/export. Byte-compatible output with the module.
import { Track, GeoPoint } from "./types";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toGpx(tr: Track): string {
  let s =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Perun" xmlns="http://www.topografix.com/GPX/1/1" ` +
    `xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n<trk>`;
  if (tr.name) s += `<name>${esc(tr.name)}</name>`;
  s += `<trkseg>\n`;
  for (const p of tr.points) {
    s += `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">`;
    if (tr.hasAlt && p.alt !== undefined) s += `<ele>${p.alt.toFixed(1)}</ele>`;
    s += `<time>${new Date(p.t).toISOString()}</time>`;
    if (tr.hasHr && p.hr !== undefined)
      s += `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${p.hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>`;
    s += `</trkpt>\n`;
  }
  return s + `</trkseg></trk></gpx>\n`;
}

// Lightweight regex parse (RN has no DOMParser). Handles Perun/Garmin/Strava GPX.
export function fromGpx(xml: string): Track {
  const nameM = xml.match(/<name>([^<]*)<\/name>/);
  const points: GeoPoint[] = [];
  let hasAlt = false, hasHr = false;
  const re = /<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[3];
    const ele = body.match(/<ele>([^<]+)<\/ele>/);
    const time = body.match(/<time>([^<]+)<\/time>/);
    const hr = body.match(/<(?:\w+:)?hr>([^<]+)<\/(?:\w+:)?hr>/);
    const p: GeoPoint = { lat: parseFloat(m[1]), lon: parseFloat(m[2]), t: time ? Date.parse(time[1]) : 0 };
    if (ele) { p.alt = parseFloat(ele[1]); hasAlt = true; }
    if (hr) { p.hr = parseInt(hr[1], 10); hasHr = true; }
    points.push(p);
  }
  return { name: nameM ? nameM[1] : undefined, hasAlt, hasHr, points };
}
