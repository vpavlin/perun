#pragma once
//
// Run analytics computed from a decoded Track — distance, duration, pace,
// elevation gain, average HR, and per-km splits. Pure std (no Qt), builds on
// track_codec.h. This is the "detailed analytics" the module adds on top of a
// raw track: the phone captures points, the module turns them into insight.
//
#include <cmath>
#include <cstdint>
#include <vector>

#include "geo.h"

namespace perun {

struct RunSummary {
  double distanceM = 0;
  double durationS = 0;
  double avgSpeedMps = 0;     // m/s
  double avgPaceSecPerKm = 0; // s/km
  double elevGainM = 0;
  double avgHr = 0;
  bool hasHr = false;
};

struct Split {
  int index = 0;         // 1-based km number
  double distanceM = 0;  // usually 1000, less for the trailing partial
  double durationS = 0;
  double paceSecPerKm = 0;
  double elevGainM = 0;
  double avgHr = 0;
};

namespace detail {
// Haversine distance in metres between two lat/lon points.
inline double haversine(double lat1, double lon1, double lat2, double lon2) {
  constexpr double R = 6371000.0, D2R = 3.14159265358979323846 / 180.0;
  const double dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const double a = std::sin(dLat / 2) * std::sin(dLat / 2) +
                   std::cos(lat1 * D2R) * std::cos(lat2 * D2R) *
                       std::sin(dLon / 2) * std::sin(dLon / 2);
  return 2 * R * std::asin(std::min(1.0, std::sqrt(a)));
}
} // namespace detail

inline RunSummary computeSummary(const Track &tr) {
  RunSummary s;
  s.hasHr = tr.hasHr;
  const auto &p = tr.points;
  if (p.size() < 2)
    return s;
  double hrSum = 0;
  int hrCount = 0;
  for (size_t i = 1; i < p.size(); ++i) {
    s.distanceM += detail::haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon);
    if (tr.hasAlt) {
      const double d = p[i].alt - p[i - 1].alt;
      if (d > 0) s.elevGainM += d;
    }
    if (tr.hasHr) { hrSum += p[i].hr; ++hrCount; }
  }
  s.durationS = (p.back().t - p.front().t) / 1000.0;
  if (s.durationS > 0) s.avgSpeedMps = s.distanceM / s.durationS;
  if (s.distanceM > 0) s.avgPaceSecPerKm = s.durationS / (s.distanceM / 1000.0);
  if (hrCount) { s.avgHr = hrSum / hrCount; }
  return s;
}

inline std::vector<Split> computeSplits(const Track &tr, double splitMeters = 1000.0) {
  std::vector<Split> splits;
  const auto &p = tr.points;
  if (p.size() < 2)
    return splits;

  int idx = 1;
  double splitDist = 0, splitElev = 0, hrSum = 0;
  int hrCount = 0;
  int64_t splitStartT = p.front().t;

  auto close = [&](int64_t endT) {
    Split sp;
    sp.index = idx++;
    sp.distanceM = splitDist;
    sp.durationS = (endT - splitStartT) / 1000.0;
    sp.elevGainM = splitElev;
    sp.avgHr = hrCount ? hrSum / hrCount : 0;
    sp.paceSecPerKm = splitDist > 0 ? sp.durationS / (splitDist / 1000.0) : 0;
    splits.push_back(sp);
  };

  for (size_t i = 1; i < p.size(); ++i) {
    splitDist += detail::haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon);
    if (tr.hasAlt) {
      const double d = p[i].alt - p[i - 1].alt;
      if (d > 0) splitElev += d;
    }
    if (tr.hasHr) { hrSum += p[i].hr; ++hrCount; }

    if (splitDist >= splitMeters) {
      close(p[i].t);
      splitStartT = p[i].t;
      splitDist = 0; splitElev = 0; hrSum = 0; hrCount = 0;
    }
  }
  // Trailing partial km (ignore sub-metre dust).
  if (splitDist > 1.0)
    close(p.back().t);
  return splits;
}

} // namespace perun
