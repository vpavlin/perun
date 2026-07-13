#pragma once
//
// Compact track codec (C++), byte-compatible with packages/contract/src/
// track-codec.mjs. Header-only, pure std — no Qt — so it is portable and
// unit-testable on its own, and re-implementable on the mobile side.
//
// Layout (see the .mjs / docs/wire-contract.md):
//   'P'(0x50) | version(1) | flags(1) | uvarint count | uvarint baseT
//   base:  svarint latE7 | svarint lonE7 | [svarint altDm] | [svarint hr] | [svarint speedCsm]
//   point: uvarint dT | svarint dLatE7 | svarint dLonE7 | [svarint dAltDm] | [svarint dHr] | [svarint dSpeedCsm]
//   flags: bit0 alt · bit1 hr · bit2 speed
//
#include <cstdint>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace perun {

struct GeoPoint {
  double lat = 0, lon = 0;
  double alt = 0;    // metres
  double speed = 0;  // m/s
  int hr = 0;        // bpm
  int64_t t = 0;     // epoch ms
};

struct Track {
  bool hasAlt = false, hasHr = false, hasSpeed = false;
  std::vector<GeoPoint> points;
};

namespace detail {
constexpr uint8_t kMagic = 0x50, kVersion = 1;
constexpr uint8_t kFAlt = 1, kFHr = 2, kFSpeed = 4;

inline void putUvarint(std::vector<uint8_t> &b, uint64_t n) {
  while (n > 0x7f) { b.push_back((n & 0x7f) | 0x80); n >>= 7; }
  b.push_back(static_cast<uint8_t>(n & 0x7f));
}
inline void putSvarint(std::vector<uint8_t> &b, int64_t n) {
  putUvarint(b, (static_cast<uint64_t>(n) << 1) ^ static_cast<uint64_t>(n >> 63));
}
inline uint64_t getUvarint(const uint8_t *b, size_t len, size_t &i) {
  uint64_t result = 0; int shift = 0; uint8_t byte;
  do {
    if (i >= len) throw std::runtime_error("track: truncated varint");
    byte = b[i++];
    result |= static_cast<uint64_t>(byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}
inline int64_t getSvarint(const uint8_t *b, size_t len, size_t &i) {
  uint64_t u = getUvarint(b, len, i);
  return static_cast<int64_t>(u >> 1) ^ -static_cast<int64_t>(u & 1);
}
inline int64_t e7(double d) { return std::llround(d * 1e7); }
inline int64_t dm(double m) { return std::llround(m * 10.0); }
inline int64_t csm(double s) { return std::llround(s * 100.0); }
} // namespace detail

inline std::vector<uint8_t> encodeTrack(const Track &tr) {
  using namespace detail;
  std::vector<uint8_t> b;
  b.push_back(kMagic); b.push_back(kVersion);
  b.push_back((tr.hasAlt ? kFAlt : 0) | (tr.hasHr ? kFHr : 0) | (tr.hasSpeed ? kFSpeed : 0));
  putUvarint(b, tr.points.size());
  if (tr.points.empty()) return b;

  const GeoPoint &p0 = tr.points[0];
  putUvarint(b, static_cast<uint64_t>(p0.t));
  int64_t pLat = e7(p0.lat), pLon = e7(p0.lon), pAlt = dm(p0.alt), pHr = p0.hr, pSpd = csm(p0.speed), pT = p0.t;
  putSvarint(b, pLat); putSvarint(b, pLon);
  if (tr.hasAlt) putSvarint(b, pAlt);
  if (tr.hasHr) putSvarint(b, pHr);
  if (tr.hasSpeed) putSvarint(b, pSpd);

  for (size_t k = 1; k < tr.points.size(); ++k) {
    const GeoPoint &p = tr.points[k];
    putUvarint(b, static_cast<uint64_t>(p.t - pT > 0 ? p.t - pT : 0)); pT = p.t;
    int64_t lat = e7(p.lat), lon = e7(p.lon);
    putSvarint(b, lat - pLat); putSvarint(b, lon - pLon); pLat = lat; pLon = lon;
    if (tr.hasAlt) { int64_t a = dm(p.alt); putSvarint(b, a - pAlt); pAlt = a; }
    if (tr.hasHr) { int64_t h = p.hr; putSvarint(b, h - pHr); pHr = h; }
    if (tr.hasSpeed) { int64_t s = csm(p.speed); putSvarint(b, s - pSpd); pSpd = s; }
  }
  return b;
}

inline Track decodeTrack(const uint8_t *b, size_t len) {
  using namespace detail;
  size_t i = 0;
  if (len < 3 || b[i++] != kMagic) throw std::runtime_error("track: bad magic");
  if (b[i++] != kVersion) throw std::runtime_error("track: bad version");
  uint8_t flags = b[i++];
  Track tr;
  tr.hasAlt = flags & kFAlt; tr.hasHr = flags & kFHr; tr.hasSpeed = flags & kFSpeed;
  uint64_t n = getUvarint(b, len, i);
  if (n == 0) return tr;

  int64_t t = static_cast<int64_t>(getUvarint(b, len, i));
  int64_t lat = getSvarint(b, len, i), lon = getSvarint(b, len, i);
  int64_t alt = tr.hasAlt ? getSvarint(b, len, i) : 0;
  int64_t hr = tr.hasHr ? getSvarint(b, len, i) : 0;
  int64_t spd = tr.hasSpeed ? getSvarint(b, len, i) : 0;
  tr.points.reserve(n);
  auto emit = [&]() {
    GeoPoint p; p.lat = lat / 1e7; p.lon = lon / 1e7; p.t = t;
    if (tr.hasAlt) p.alt = alt / 10.0;
    if (tr.hasHr) p.hr = static_cast<int>(hr);
    if (tr.hasSpeed) p.speed = spd / 100.0;
    tr.points.push_back(p);
  };
  emit();
  for (uint64_t k = 1; k < n; ++k) {
    t += static_cast<int64_t>(getUvarint(b, len, i));
    lat += getSvarint(b, len, i); lon += getSvarint(b, len, i);
    if (tr.hasAlt) alt += getSvarint(b, len, i);
    if (tr.hasHr) hr += getSvarint(b, len, i);
    if (tr.hasSpeed) spd += getSvarint(b, len, i);
    emit();
  }
  return tr;
}

inline Track decodeTrack(const std::vector<uint8_t> &b) { return decodeTrack(b.data(), b.size()); }

} // namespace perun
