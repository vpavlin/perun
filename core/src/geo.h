#pragma once
// Shared geo types — one point model used by GPX (de)serialization and the
// analytics. Pure std; no Qt, no external deps.
#include <cstdint>
#include <string>
#include <vector>

namespace perun {

struct GeoPoint {
  double lat = 0, lon = 0;
  double alt = 0;    // metres
  // A GPS fix can arrive with no vertical component, so the phone omits <ele>
  // for that trkpt (mobile writes it only when p.alt is defined). Without a
  // per-point flag those points parse to alt=0 and the analytics count a phantom
  // ±alt swing across them — the elevation-gain-way-too-high bug. Mirrors the
  // "skip undefined alt" behaviour in mobile/src/lib/analytics.ts.
  bool altValid = false;
  double speed = 0;  // m/s (derived; not carried in GPX trkpt)
  int hr = 0;        // bpm
  int64_t t = 0;     // epoch ms
  // A gap precedes this point — it opens a new GPX <trkseg> (a pause on the
  // phone, or a signal dropout from a watch). Analytics must not bridge it:
  // pausing, driving home and resuming would otherwise add the drive to your
  // distance. Mirrors GeoPoint.brk in mobile/src/lib/types.ts.
  bool brk = false;
};

struct Track {
  bool hasAlt = false, hasHr = false, hasSpeed = false;
  std::string name;
  std::string sport;    // what you did — GPX <trk><type> (see isKnownSport)
  std::string category; // how you trained — perun:category extension
  std::vector<GeoPoint> points;
};

// Sport ids. Must stay in sync with the phone's SPORTS table (mobile/src/lib/
// types.ts): the id travels over the wire in <type>, so a value missing here is
// demoted to a category by fromGpx and the run lands mis-tagged.
inline bool isKnownSport(const std::string &s) {
  return s == "running" || s == "trail_running" || s == "walking" ||
         s == "hiking" || s == "cycling" || s == "mtb";
}

} // namespace perun
