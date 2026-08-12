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

// Threshold-from-trough ascent accumulator — the C++ mirror of
// makeElevAccumulator in mobile/src/lib/analytics.ts (keep them in step). GPS
// altitude is noisy AND intermittent, so the old `alt - prevAlt, keep if >0`
// both counted phantom swings across no-altitude points (alt=0) and summed raw
// jitter → gain came out wildly high. This ignores samples with no valid
// altitude and credits a climb only once it clears a 5 m noise floor measured
// from the last local trough.
constexpr double kElevThresholdM = 5.0;
struct ElevAccumulator {
  double ref = 0;     // last committed peak / running trough
  bool primed = false;
  void reset() { primed = false; } // call across a break so a pause isn't bridged
  // Feed one point; returns metres of ascent to credit (0 unless a sustained
  // climb just cleared the threshold).
  double add(const GeoPoint &p) {
    if (!p.altValid)
      return 0.0;
    if (!primed) { ref = p.alt; primed = true; return 0.0; }
    const double d = p.alt - ref;
    if (d >= kElevThresholdM) { ref = p.alt; return d; } // committed climb
    if (p.alt < ref) ref = p.alt; // new low — measure the next climb from here
    return 0.0;
  }
};
} // namespace detail

inline RunSummary computeSummary(const Track &tr) {
  RunSummary s;
  s.hasHr = tr.hasHr;
  const auto &p = tr.points;
  if (p.size() < 2)
    return s;
  double hrSum = 0;
  int hrCount = 0;
  int64_t movingMs = 0;
  detail::ElevAccumulator elev;
  if (tr.hasAlt) elev.add(p[0]); // seed the trough from the first fix
  for (size_t i = 1; i < p.size(); ++i) {
    // Skip the pair spanning a pause: no distance covered by the activity, and
    // the wall time in between is not moving time.
    if (!p[i].brk) {
      s.distanceM += detail::haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon);
      movingMs += p[i].t - p[i - 1].t;
      if (tr.hasAlt) s.elevGainM += elev.add(p[i]);
    } else if (tr.hasAlt) {
      elev.reset(); // don't bridge an ascent across a pause/teleport
    }
    if (tr.hasHr) { hrSum += p[i].hr; ++hrCount; }
  }
  // Sum of per-step deltas, not back-minus-front: identical when there are no
  // breaks, so unpaused runs are unaffected.
  s.durationS = movingMs / 1000.0;
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
  // Accumulate moving time so a pause mid-kilometre doesn't inflate that
  // split's pace.
  int64_t splitMs = 0;
  // One accumulator for the whole track (trough reference carries across km
  // boundaries); committed ascent lands in whichever split it happened in.
  detail::ElevAccumulator elev;
  if (tr.hasAlt) elev.add(p[0]);

  auto close = [&]() {
    Split sp;
    sp.index = idx++;
    sp.distanceM = splitDist;
    sp.durationS = splitMs / 1000.0;
    sp.elevGainM = splitElev;
    sp.avgHr = hrCount ? hrSum / hrCount : 0;
    sp.paceSecPerKm = splitDist > 0 ? sp.durationS / (splitDist / 1000.0) : 0;
    splits.push_back(sp);
  };

  for (size_t i = 1; i < p.size(); ++i) {
    if (!p[i].brk) {
      splitDist += detail::haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon);
      splitMs += p[i].t - p[i - 1].t;
      if (tr.hasAlt) splitElev += elev.add(p[i]);
    } else if (tr.hasAlt) {
      elev.reset();
    }
    if (tr.hasHr) { hrSum += p[i].hr; ++hrCount; }

    if (splitDist >= splitMeters) {
      close();
      splitDist = 0; splitElev = 0; hrSum = 0; hrCount = 0; splitMs = 0;
    }
  }
  // Trailing partial km (ignore sub-metre dust).
  if (splitDist > 1.0)
    close();
  return splits;
}

} // namespace perun
