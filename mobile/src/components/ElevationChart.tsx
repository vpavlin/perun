// Elevation profile: altitude (m) plotted over cumulative distance. A small
// area-under-line SVG chart, theme-coloured to match the route. Used on the live
// recording page and the run detail. Renders nothing useful without >=2 points
// carrying `alt`, so it self-guards to a one-line "no elevation data" note.
import React from "react";
import {
  View, Text, StyleSheet, PanResponder, PanResponderInstance, GestureResponderEvent,
} from "react-native";
import Svg, { Polyline, Line } from "react-native-svg";
import { GeoPoint } from "../lib/types";
import { haversine } from "../lib/analytics";
import { theme } from "../theme";

export function ElevationChart({
  points, width, height, playheadD, axisMaxD, onScrubD,
}: {
  points: GeoPoint[];
  width: number;
  height: number;
  /** Replay playhead position, in cumulative metres — drawn as a vertical marker. */
  playheadD?: number;
  /** Override the x-axis max distance so it matches the route map's full-route axis
   *  (the trace's own last-altitude distance may be slightly shorter). */
  axisMaxD?: number;
  /** When set, dragging the chart reports the scrubbed distance (metres). */
  onScrubD?: (d: number) => void;
}) {
  // Scrub responder — created once, reads latest geometry via a ref (hooks must run
  // before any early return, hence up here). scrubRef is filled in below once maxD is known.
  const scrubRef = React.useRef<{ cb?: (d: number) => void; width: number; maxD: number; pad: number }>({ width, maxD: 1, pad: 6 });
  const handleScrub = React.useCallback((e: GestureResponderEvent) => {
    const s = scrubRef.current;
    if (!s.cb) return;
    const frac = Math.max(0, Math.min(1, (e.nativeEvent.locationX - s.pad) / Math.max(1, s.width - 2 * s.pad)));
    s.cb(frac * s.maxD);
  }, []);
  const panRef = React.useRef<PanResponderInstance | null>(null);
  if (!panRef.current) {
    panRef.current = PanResponder.create({
      onStartShouldSetPanResponder: () => !!scrubRef.current.cb,
      onMoveShouldSetPanResponder: () => !!scrubRef.current.cb,
      onPanResponderGrant: handleScrub,
      onPanResponderMove: handleScrub,
    });
  }

  // (cumulativeDistanceM, altM) series, skipping points with no altitude fix.
  const raw: { d: number; a: number }[] = [];
  let dist = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && !points[i].brk) {
      dist += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }
    if (points[i].alt != null && Number.isFinite(points[i].alt)) raw.push({ d: dist, a: points[i].alt! });
  }

  // Light centred moving average — raw GPS altitude is jittery enough that the
  // unsmoothed trace reads as noise rather than terrain.
  const WIN = 2; // ±2 samples
  const series = raw.map((pt, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - WIN); j <= Math.min(raw.length - 1, i + WIN); j++) { sum += raw[j].a; n++; }
    return { d: pt.d, a: sum / n };
  });

  if (series.length < 2) {
    return (
      <View style={[styles.empty, { width, height }]}>
        <Text style={styles.emptyText}>No elevation data yet</Text>
      </View>
    );
  }

  const alts = series.map((s) => s.a);
  const minA = Math.min(...alts);
  const maxA = Math.max(...alts);
  const spanA = Math.max(1, maxA - minA); // avoid /0 on a dead-flat run
  // Share the route map's axis when given, so the elevation playhead lines up with
  // the map dot even if the last points carried no altitude.
  const maxD = Math.max(1, axisMaxD ?? series[series.length - 1].d);
  const pad = 6;
  const x = (d: number) => pad + (d / maxD) * (width - 2 * pad);
  const y = (a: number) => height - pad - ((a - minA) / spanA) * (height - 2 * pad);

  const line = series.map((s) => `${x(s.d).toFixed(1)},${y(s.a).toFixed(1)}`).join(" ");
  // Close the polygon down to the baseline for a soft fill under the trace.
  const area = `${x(0).toFixed(1)},${(height - pad).toFixed(1)} ${line} ${x(maxD).toFixed(1)},${(height - pad).toFixed(1)}`;

  // Now that geometry is known, expose it to the scrub responder.
  scrubRef.current = { cb: onScrubD, width, maxD, pad };
  const phX = playheadD != null ? x(Math.max(0, Math.min(maxD, playheadD))) : null;

  return (
    <View>
      <Svg width={width} height={height}>
        {/* baseline */}
        <Line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke={theme.border} strokeWidth={1} />
        <Polyline points={area} fill={theme.primary} opacity={0.13} stroke="none" />
        <Polyline points={line} fill="none" stroke={theme.primary} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {phX != null && (
          <Line x1={phX} y1={pad} x2={phX} y2={height - pad} stroke={theme.text} strokeWidth={1.5} opacity={0.8} />
        )}
      </Svg>
      {onScrubD && <View style={StyleSheet.absoluteFill} {...panRef.current.panHandlers} />}
      {/* min/max labels pinned to the corners they belong to */}
      <Text style={[styles.lbl, { top: 2, right: 6 }]}>{Math.round(maxA)} m</Text>
      <Text style={[styles.lbl, { bottom: 2, right: 6 }]}>{Math.round(minA)} m</Text>
      <Text style={[styles.lbl, { bottom: 2, left: 6 }]}>+{Math.round(maxA - minA)} m range</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: "center", justifyContent: "center", backgroundColor: theme.elevated, borderRadius: 10, borderWidth: 1, borderColor: theme.border },
  emptyText: { color: theme.textTertiary, fontSize: 13 },
  lbl: { position: "absolute", color: theme.textTertiary, fontSize: 10, fontWeight: "600" },
});
