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
  double speed = 0;  // m/s (derived; not carried in GPX trkpt)
  int hr = 0;        // bpm
  int64_t t = 0;     // epoch ms
};

struct Track {
  bool hasAlt = false, hasHr = false, hasSpeed = false;
  std::string name;
  std::string type; // activity category — GPX <trk><type>
  std::vector<GeoPoint> points;
};

} // namespace perun
