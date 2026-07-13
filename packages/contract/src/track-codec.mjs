// Perun compact track codec — dependency-free, portable (re-implementable in C++/Kotlin).
// Format: header + delta-encoded points. Coordinates are fixed-point 1e-7 deg (~1.1 cm),
// altitude in decimeters, timestamps in ms. Deltas are zig-zag varint encoded.
//
// Layout:
//   'P' (0x50) | version(1) | flags(1) | uvarint count | uvarint baseT
//   base: svarint latE7 | svarint lonE7 | [svarint altDm] | [svarint hr] | [svarint speedCsm]
//   per subsequent point: uvarint dT | svarint dLatE7 | svarint dLonE7
//                         | [svarint dAltDm] | [svarint dHr] | [svarint dSpeedCsm]
// flags: bit0 alt, bit1 hr, bit2 speed

const MAGIC = 0x50, VERSION = 1;
const F_ALT = 1, F_HR = 2, F_SPEED = 4;

class Writer {
  constructor() { this.b = []; }
  u8(n) { this.b.push(n & 0xff); }
  uvarint(n) { // non-negative integer (safe up to 2^53)
    while (n > 0x7f) { this.b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    this.b.push(n & 0x7f);
  }
  svarint(n) { this.uvarint(n >= 0 ? n * 2 : -n * 2 - 1); } // zig-zag
  bytes() { return Uint8Array.from(this.b); }
}
class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  u8() { return this.b[this.i++]; }
  uvarint() {
    let shift = 1, result = 0, byte;
    do { byte = this.b[this.i++]; result += (byte & 0x7f) * shift; shift *= 128; } while (byte & 0x80);
    return result;
  }
  svarint() { const u = this.uvarint(); return (u % 2 === 0) ? u / 2 : -(u + 1) / 2; }
}

const e7 = (d) => Math.round(d * 1e7);
const de7 = (i) => i / 1e7;
const dm = (m) => Math.round(m * 10);      // metres -> decimetres
const csm = (s) => Math.round(s * 100);    // m/s -> centi-m/s

export function encodeTrack(points, opts = {}) {
  const hasAlt = !!opts.alt, hasHr = !!opts.hr, hasSpeed = !!opts.speed;
  const w = new Writer();
  w.u8(MAGIC); w.u8(VERSION);
  w.u8((hasAlt ? F_ALT : 0) | (hasHr ? F_HR : 0) | (hasSpeed ? F_SPEED : 0));
  w.uvarint(points.length);
  if (points.length === 0) return w.bytes();

  const p0 = points[0];
  w.uvarint(p0.t);
  let pLat = e7(p0.lat), pLon = e7(p0.lon);
  let pAlt = hasAlt ? dm(p0.alt ?? 0) : 0;
  let pHr = hasHr ? Math.round(p0.hr ?? 0) : 0;
  let pSpd = hasSpeed ? csm(p0.speed ?? 0) : 0;
  let pT = p0.t;
  w.svarint(pLat); w.svarint(pLon);
  if (hasAlt) w.svarint(pAlt);
  if (hasHr) w.svarint(pHr);
  if (hasSpeed) w.svarint(pSpd);

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    w.uvarint(Math.max(0, p.t - pT)); pT = p.t;
    const lat = e7(p.lat), lon = e7(p.lon);
    w.svarint(lat - pLat); w.svarint(lon - pLon); pLat = lat; pLon = lon;
    if (hasAlt) { const a = dm(p.alt ?? 0); w.svarint(a - pAlt); pAlt = a; }
    if (hasHr) { const h = Math.round(p.hr ?? 0); w.svarint(h - pHr); pHr = h; }
    if (hasSpeed) { const s = csm(p.speed ?? 0); w.svarint(s - pSpd); pSpd = s; }
  }
  return w.bytes();
}

export function decodeTrack(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== MAGIC) throw new Error("bad magic");
  const version = r.u8(); if (version !== VERSION) throw new Error("bad version " + version);
  const flags = r.u8();
  const hasAlt = !!(flags & F_ALT), hasHr = !!(flags & F_HR), hasSpeed = !!(flags & F_SPEED);
  const n = r.uvarint();
  const out = [];
  if (n === 0) return out;

  let t = r.uvarint();
  let lat = r.svarint(), lon = r.svarint();
  let alt = hasAlt ? r.svarint() : 0, hr = hasHr ? r.svarint() : 0, spd = hasSpeed ? r.svarint() : 0;
  const emit = () => {
    const p = { lat: de7(lat), lon: de7(lon), t };
    if (hasAlt) p.alt = alt / 10;
    if (hasHr) p.hr = hr;
    if (hasSpeed) p.speed = spd / 100;
    out.push(p);
  };
  emit();
  for (let i = 1; i < n; i++) {
    t += r.uvarint();
    lat += r.svarint(); lon += r.svarint();
    if (hasAlt) alt += r.svarint();
    if (hasHr) hr += r.svarint();
    if (hasSpeed) spd += r.svarint();
    emit();
  }
  return out;
}

// Split a point array so each encoded chunk stays <= maxRawBytes (before base64/envelope).
export function chunkTrack(points, opts, maxRawBytes) {
  const chunks = [];
  let start = 0;
  while (start < points.length) {
    // grow the window until it would exceed the budget, then back off one
    let lo = start + 1, hi = points.length, best = start + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const size = encodeTrack(points.slice(start, mid), opts).length;
      if (size <= maxRawBytes) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    chunks.push(points.slice(start, best));
    start = best;
  }
  return chunks;
}
