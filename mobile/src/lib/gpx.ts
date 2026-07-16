// GPX 1.1 (Garmin HR extension) <-> Track — TS port of the module's gpx.h.
// This is the interchange format the phone sends over Delivery (gzipped) and
// what Garmin/Strava import/export. Byte-compatible output with the module.
import { Track, GeoPoint, Sport, SPORTS } from "./types";

// & must go first, or we'd double-escape the entities we just introduced.
// Quotes are escaped only to stay byte-identical with the module's xmlEscape()
// (they carry no special meaning in element text) — see the round-trip check.
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export const PERUN_NS = "https://github.com/vpavlin/perun/1";

export function toGpx(tr: Track): string {
  let s =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Perun" xmlns="http://www.topografix.com/GPX/1/1" ` +
    `xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" ` +
    `xmlns:perun="${PERUN_NS}">\n<trk>`;
  if (tr.name) s += `<name>${esc(tr.name)}</name>`;
  // <type> is the standard GPX ACTIVITY type — Strava/Garmin classify the activity
  // from it, so it carries the sport. The training category is ours, so it rides
  // in a perun: extension (3rd parties ignore unknown extensions).
  // Schema order: name → … → type → extensions → trkseg.
  if (tr.sport) s += `<type>${esc(tr.sport)}</type>`;
  if (tr.category)
    s += `<extensions><perun:category>${esc(tr.category)}</perun:category></extensions>`;
  s += `<trkseg>\n`;
  for (let i = 0; i < tr.points.length; i++) {
    const p = tr.points[i];
    // A break opens a new <trkseg> — that IS how GPX represents a pause, and
    // every reader (Strava/Garmin) already knows not to draw across segments.
    if (p.brk && i > 0) s += `</trkseg><trkseg>\n`;
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
// Must decode &apos;/&quot; too: the module's writer emits them, and so do
// Strava/Garmin exports. Decoding &amp; LAST is what keeps a literal "&amp;lt;"
// in a run name from collapsing into "<".
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export function fromGpx(xml: string): Track {
  // Scope name/type to the <trk> header (before <trkseg>) so we don't pick up a
  // <name> from <metadata> or a <type> from a <link>.
  const trkStart = xml.indexOf("<trk>");
  const segStart = xml.indexOf("<trkseg", trkStart < 0 ? 0 : trkStart);
  const head = trkStart >= 0 && segStart > trkStart ? xml.slice(trkStart, segStart) : "";
  const nameM = head.match(/<name>([^<]*)<\/name>/);
  const typeM = head.match(/<type>([^<]*)<\/type>/);
  const catM = head.match(/<(?:\w+:)?category>([^<]*)<\/(?:\w+:)?category>/);
  const points: GeoPoint[] = [];
  let hasAlt = false, hasHr = false;
  const PT_RE = /<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  const parsePoints = (chunk: string, markFirst: boolean) => {
    const re = new RegExp(PT_RE.source, "g");
    let m: RegExpExecArray | null;
    let first = true;
    while ((m = re.exec(chunk))) {
      const body = m[3];
      const ele = body.match(/<ele>([^<]+)<\/ele>/);
      const time = body.match(/<time>([^<]+)<\/time>/);
      const hr = body.match(/<(?:\w+:)?hr>([^<]+)<\/(?:\w+:)?hr>/);
      const p: GeoPoint = { lat: parseFloat(m[1]), lon: parseFloat(m[2]), t: time ? Date.parse(time[1]) : 0 };
      if (ele) { p.alt = parseFloat(ele[1]); hasAlt = true; }
      if (hr) { p.hr = parseInt(hr[1], 10); hasHr = true; }
      if (markFirst && first) p.brk = true;
      first = false;
      points.push(p);
    }
  };
  // Each <trkseg> after the first opens with a break — that's a pause (ours) or
  // a signal dropout (Garmin's). Either way the gap must not be bridged.
  const segRe = /<trkseg[^>]*>([\s\S]*?)<\/trkseg>/g;
  let seg: RegExpExecArray | null;
  let segIdx = 0;
  while ((seg = segRe.exec(xml))) {
    parsePoints(seg[1], segIdx > 0);
    segIdx++;
  }
  // Malformed GPX with trkpts but no trkseg wrapper: fall back to a flat scan
  // rather than silently returning an empty track.
  if (segIdx === 0) parsePoints(xml, false);
  // <type> normally holds the sport. But runs written BEFORE the sport/category
  // split put the CATEGORY there (e.g. "Long"), so an unrecognised value is
  // treated as a category — old tracks degrade correctly instead of claiming to
  // be a sport called "Long".
  const rawType = typeM ? unesc(typeM[1]) : undefined;
  const known = rawType && SPORTS.some((s) => s.id === rawType);
  return {
    name: nameM ? unesc(nameM[1]) : undefined,
    sport: known ? (rawType as Sport) : undefined,
    category: catM ? unesc(catM[1]) : known ? undefined : rawType,
    hasAlt,
    hasHr,
    points,
  };
}
