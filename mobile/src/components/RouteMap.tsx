// Self-drawn route map (SVG polyline of the GPS track) — the RN counterpart of
// the module's QtQuick.Shapes map. No tiles/network; auto-scaled with start
// (green) / end (red) markers.
import React from "react";
import Svg, { Polyline, Circle } from "react-native-svg";
import { GeoPoint } from "../lib/types";
import { theme } from "../theme";

export function RouteMap({ points, width, height }: { points: GeoPoint[]; width: number; height: number }) {
  if (!points || points.length < 2) return null;
  let latMin = 1e9, latMax = -1e9, lonMin = 1e9, lonMax = -1e9;
  for (const p of points) {
    if (p.lat < latMin) latMin = p.lat;
    if (p.lat > latMax) latMax = p.lat;
    if (p.lon < lonMin) lonMin = p.lon;
    if (p.lon > lonMax) lonMax = p.lon;
  }
  const m = 12;
  const cosLat = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
  const spanX = Math.max(1e-9, (lonMax - lonMin) * cosLat);
  const spanY = Math.max(1e-9, latMax - latMin);
  const scale = Math.min((width - 2 * m) / spanX, (height - 2 * m) / spanY);
  const drawW = spanX * scale, drawH = spanY * scale;
  const ox = (width - drawW) / 2, oy = (height - drawH) / 2;
  const X = (p: GeoPoint) => ox + (p.lon - lonMin) * cosLat * scale;
  const Y = (p: GeoPoint) => oy + drawH - (p.lat - latMin) * scale;

  const pts = points.map((p) => `${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join(" ");
  const s = points[0], e = points[points.length - 1];
  return (
    <Svg width={width} height={height}>
      <Polyline points={pts} fill="none" stroke={theme.primary} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={X(s)} cy={Y(s)} r={4.5} fill={theme.success} />
      <Circle cx={X(e)} cy={Y(e)} r={4.5} fill={theme.error} />
    </Svg>
  );
}
