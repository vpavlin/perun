// Route map: OSM raster basemap (Web Mercator) with the GPS track drawn on top
// in the same projection, so the line registers with the map. Tiles are cached
// on disk and fetched at most once; if none load (offline / fetch error) we fall
// back to exactly the old behaviour — the track on the plain dark background.
import React from "react";
import { GestureResponderEvent, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Image as SvgImage, Polyline, Rect } from "react-native-svg";
import { buildLayout, getTile, MapLayout, TILE_SIZE } from "../lib/tiles";
import { GeoPoint } from "../lib/types";
import { theme } from "../theme";

/** A pin drawn on the route at (lat,lon). `kind` colours it; `id` links it to a list row. */
export interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  kind: string;
}

// Marker colour per annotation kind (falls back to primary).
function markerColor(kind: string): string {
  if (kind === "photo") return "#4aa3ff";
  if (kind === "voice") return "#c07af0";
  return theme.primary; // text
}

// Resolve a layout's tiles to file:// URIs. Keyed on layout.key (bbox+zoom), so
// the live view — which re-renders ~1/s as points stream in — only refetches
// when the tile set actually changes, not on every new point.
function useTiles(layout: MapLayout | null): Record<string, string> {
  const [uris, setUris] = React.useState<Record<string, string>>({});
  const key = layout?.key;

  React.useEffect(() => {
    if (!layout) return;
    let alive = true;
    // Don't clear on bbox growth: uris are keyed by tile id (z/x/y) and tile
    // content is projection-independent, so keeping resolved tiles avoids the
    // basemap flickering as the live track expands. Stale ids simply go unused.
    for (const t of layout.tiles) {
      getTile(t.z, t.x, t.y).then((uri) => {
        if (alive && uri) setUris((prev) => (prev[t.id] ? prev : { ...prev, [t.id]: uri }));
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return uris;
}

export function RouteMap({
  points,
  width,
  height,
  hideBasemap = false,
  fitPoints,
  markers,
  onMarkerPress,
  highlightId,
  pickMode = false,
  onPickPoint,
  pickedPoint,
}: {
  points: GeoPoint[];
  width: number;
  height: number;
  /** Drop the OSM basemap — draw the track on the plain dark background only.
   *  For privacy when sharing (the route shape stays, the where does not). */
  hideBasemap?: boolean;
  /** Points to fit the viewport to (defaults to `points`). Pass a subset — e.g.
   *  the last ~150 m — for a "follow"/zoomed crop while the full track is still
   *  drawn. The projection is shared, so the polyline still registers. */
  fitPoints?: GeoPoint[];
  /** Annotation pins to draw on the route. */
  markers?: MapMarker[];
  /** Tapped a pin → focus its list row. */
  onMarkerPress?: (id: string) => void;
  /** Draw this marker larger (the focused list row). */
  highlightId?: string;
  /** When true, tapping the map picks the nearest track point (onPickPoint). */
  pickMode?: boolean;
  onPickPoint?: (p: GeoPoint) => void;
  /** A candidate point being placed (shown as a hollow ring). */
  pickedPoint?: GeoPoint | null;
}) {
  const fit = fitPoints && fitPoints.length >= 2 ? fitPoints : points;
  const layout = React.useMemo(() => buildLayout(fit, width, height), [fit, width, height]);
  // Skip the tile fetch entirely when the basemap is hidden — no network, and
  // the effect's key never changes so it stays quiet.
  const uris = useTiles(hideBasemap ? null : layout);
  if (!points || points.length < 2 || !layout) return null;

  // Tap → nearest track point (by projected screen distance). Used to place an
  // annotation on the route post-hoc.
  const onTap = (e: GestureResponderEvent) => {
    if (!pickMode || !onPickPoint || !layout) return;
    const { locationX, locationY } = e.nativeEvent;
    let best: GeoPoint | null = null;
    let bestD = Infinity;
    for (const p of points) {
      const [px, py] = layout.project(p);
      const d = (px - locationX) ** 2 + (py - locationY) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) onPickPoint(best);
  };

  // One polyline per segment: a point flagged `brk` opens a new one, so a pause
  // shows as a gap instead of a straight line teleporting across the map.
  const segments: string[] = [];
  let cur: string[] = [];
  for (const p of points) {
    if (p.brk && cur.length) { segments.push(cur.join(" ")); cur = []; }
    cur.push(layout.project(p).map((n) => n.toFixed(1)).join(","));
  }
  if (cur.length) segments.push(cur.join(" "));

  const [sx, sy] = layout.project(points[0]);
  const [ex, ey] = layout.project(points[points.length - 1]);
  const hasTiles = !hideBasemap && layout.tiles.some((t) => uris[t.id]);

  return (
    <View>
      <Svg width={width} height={height}>
        {/* Gate on hideBasemap, not just on `uris`: once tiles are fetched they
            stay cached in `uris`, so toggling hide AFTER they loaded would keep
            drawing them. This is what makes "Hide map" actually hide it. */}
        {!hideBasemap && layout.tiles.map((t) =>
          uris[t.id] ? (
            <SvgImage
              key={t.key}
              x={t.sx}
              y={t.sy}
              width={TILE_SIZE}
              height={TILE_SIZE}
              href={{ uri: uris[t.id] }}
              preserveAspectRatio="xMidYMid slice"
            />
          ) : null
        )}
        {/* Dark scrim so bright tiles don't glare and the orange track stays legible. */}
        {hasTiles && <Rect x={0} y={0} width={width} height={height} fill={theme.bg} opacity={0.45} />}
        {segments.map((seg, i) => (
          <Polyline key={i} points={seg} fill="none" stroke={theme.primary} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        <Circle cx={sx} cy={sy} r={4.5} fill={theme.success} stroke={theme.bg} strokeWidth={1.5} />
        <Circle cx={ex} cy={ey} r={4.5} fill={theme.error} stroke={theme.bg} strokeWidth={1.5} />
        {/* Candidate point being placed (before the note is authored). */}
        {pickedPoint && (() => {
          const [px, py] = layout.project(pickedPoint);
          return <Circle cx={px} cy={py} r={7} fill="none" stroke={theme.text} strokeWidth={2} />;
        })()}
        {/* Annotation pins. A larger transparent circle beneath widens the touch target. */}
        {markers?.map((mk) => {
          const [px, py] = layout.project({ lat: mk.lat, lon: mk.lon, t: 0 });
          const on = mk.id === highlightId;
          return (
            <React.Fragment key={mk.id}>
              <Circle cx={px} cy={py} r={14} fill="transparent" onPress={() => onMarkerPress?.(mk.id)} />
              <Circle
                cx={px}
                cy={py}
                r={on ? 7 : 5}
                fill={markerColor(mk.kind)}
                stroke={theme.bg}
                strokeWidth={on ? 2.5 : 1.5}
                onPress={() => onMarkerPress?.(mk.id)}
              />
            </React.Fragment>
          );
        })}
      </Svg>
      {/* Transparent tap layer for placing a point — only mounted in pick mode so it
          never steals touches from the map controls in normal viewing. */}
      {pickMode && <Pressable style={StyleSheet.absoluteFill} onPress={onTap} />}
      {/* Required by the OSM tile usage policy whenever tiles are shown. */}
      {hasTiles && <Text style={styles.attribution}>© OpenStreetMap contributors</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  attribution: {
    position: "absolute",
    right: 4,
    bottom: 3,
    fontSize: 9,
    color: theme.text,
    backgroundColor: "rgba(13,16,19,0.55)",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: "hidden",
  },
});
