// Replay mode — "relive the run". Drag a playhead along the route (on the map, or on
// the elevation strip; the two stay synced) and the annotation you're passing surfaces
// with the stats at that point. Manual scrub only for v1 (auto-play is a follow-up).
//
// The playhead is a single value: cumulative distance in metres (see lib/route). The
// map dot, the elevation marker and the featured annotation are all derived from it.
import React, { useMemo, useState } from "react";
import {
  Alert, Dimensions, Modal, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View,
} from "react-native";
import { Run } from "../lib/types";
import { Annotation, useAnnotations, deleteAnnotation, editAnnotation } from "../lib/annotations";
import {
  cumulativeDistances, totalDistance, pointAtDistance, distanceForTime,
} from "../lib/route";
import { fmtDist, fmtDur, fmtElev } from "../lib/analytics";
import { RouteMap } from "./RouteMap";
import { ElevationChart } from "./ElevationChart";
import { QuickAnnotate } from "./QuickAnnotate";
import { PhotoFull, VoicePlayer } from "./Annotations";
import { theme } from "../theme";

const KIND_ICON: Record<string, string> = { text: "💬", photo: "📷", voice: "🎙️" };
const fmtClock = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function ReplayMode({ run, visible, onClose }: { run: Run; visible: boolean; onClose: () => void }) {
  const points = run.track.points;
  const annotations = useAnnotations(run.id);
  const cum = useMemo(() => cumulativeDistances(points), [points]);
  const total = totalDistance(cum);
  const startT = points[0]?.t ?? 0;

  // Playhead distance (m). Starts at the first annotation if there is one, else 0.
  const [d, setD] = useState(0);
  // Full-screen photo viewer (tap the featured photo to expand).
  const [photoView, setPhotoView] = useState<Annotation | null>(null);
  // In-place text/caption edit of an annotation.
  const [editing, setEditing] = useState<Annotation | null>(null);
  const [editText, setEditText] = useState("");
  // Zoom the map to a window around the playhead for precise pin placement.
  const [zoom, setZoom] = useState(false);
  const [zoomR, setZoomR] = useState(150); // crop radius in metres either side of the playhead

  const zoomPts = useMemo(() => {
    if (!zoom) return undefined;
    const sub = points.filter((_, i) => cum[i] >= d - zoomR && cum[i] <= d + zoomR);
    return sub.length >= 2 ? sub : undefined; // fall back to the full route near the ends
  }, [zoom, d, zoomR, points, cum]);

  // Annotations placed on the distance axis (by the point-time they were pinned at),
  // sorted along the route. Filter out any without a resolvable position.
  const placed = useMemo(() => {
    return annotations
      .map((a) => ({ a, dist: distanceForTime(points, cum, a.t) }))
      .sort((x, y) => x.dist - y.dist);
  }, [annotations, points, cum]);

  const head = pointAtDistance(points, cum, d);
  const elapsedS = head ? Math.max(0, (head.t - startT) / 1000) : 0;

  // Featured annotation = the nearest one to the playhead; "active" when close enough
  // that you're effectively standing on it (2% of the route, min 40 m).
  const threshold = Math.max(40, total * 0.02);
  let featured: { a: Annotation; dist: number } | null = null;
  let bestGap = Infinity;
  for (const p of placed) {
    const gap = Math.abs(p.dist - d);
    if (gap < bestGap) { bestGap = gap; featured = p; }
  }
  const active = !!featured && bestGap <= threshold;

  const confirmDelete = (a: Annotation) => {
    Alert.alert("Delete annotation?", "Removes it for everyone (an append-only tombstone).", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => { void deleteAnnotation(a); } },
    ]);
  };
  const startEdit = (a: Annotation) => { setEditText(a.text ?? ""); setEditing(a); };
  const saveEdit = async () => {
    if (editing) await editAnnotation(editing, editText);
    setEditing(null);
  };

  const w = Dimensions.get("window").width - 32;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>Replay · {run.name}</Text>
          <Pressable onPress={onClose} hitSlop={12}><Text style={styles.close}>Done</Text></Pressable>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
          {points.length < 2 ? (
            <Text style={styles.empty}>This run has no route to replay.</Text>
          ) : (
            <>
              {/* Map — full route, playhead, drag to scrub. */}
              <View style={[styles.mapBox, { width: w, height: 300 }]}>
                <RouteMap
                  points={points}
                  width={w}
                  height={300}
                  markers={placed.map((p) => ({ id: p.a.id, lat: p.a.lat, lon: p.a.lon, kind: p.a.kind }))}
                  highlightId={featured?.a.id}
                  playhead={head}
                  fitPoints={zoomPts}
                  onScrubIndex={(i) => setD(cum[i] ?? 0)}
                />
              </View>
              {/* Zoom crops the map to a window around the playhead and follows it as you
                  scrub — so you can pin on the exact spot. */}
              <View style={styles.zoomRow}>
                <Pressable style={[styles.zoomToggle, zoom && styles.zoomToggleOn]} onPress={() => setZoom((v) => !v)}>
                  <Text style={[styles.zoomToggleText, zoom && styles.zoomToggleTextOn]}>
                    {zoom ? `◉ Zoomed ±${zoomR} m` : "◎ Zoom to playhead"}
                  </Text>
                </Pressable>
                {zoom && (
                  <>
                    <Pressable style={styles.zoomBtn} onPress={() => setZoomR((r) => Math.min(1500, Math.round(r * 1.6)))}>
                      <Text style={styles.zoomBtnText}>–</Text>
                    </Pressable>
                    <Pressable style={styles.zoomBtn} onPress={() => setZoomR((r) => Math.max(30, Math.round(r / 1.6)))}>
                      <Text style={styles.zoomBtnText}>+</Text>
                    </Pressable>
                  </>
                )}
              </View>
              <Text style={styles.hint}>Drag on the route or the elevation strip to move along the run.</Text>

              {/* Live stats at the playhead. */}
              <View style={styles.statRow}>
                <Stat k="Distance" v={fmtDist(d)} />
                <Stat k="Time" v={fmtDur(elapsedS)} />
                <Stat k="Elevation" v={head?.alt != null ? fmtElev(head.alt) : "—"} />
              </View>

              {/* Elevation strip — also a scrubber; playhead shares the map's axis. */}
              <View style={[styles.elevBox, { width: w, height: 96 }]}>
                <ElevationChart points={points} width={w} height={96} playheadD={d} axisMaxD={total} onScrubD={setD} />
              </View>

              {/* Compose — pin a new note/photo/voice at the EXACT playhead spot. */}
              <QuickAnnotate
                runId={run.id}
                point={head}
                title="PIN AT THIS SPOT"
                emptyHint="Scrub to a spot on the route to pin a note here."
              />

              {/* Featured annotation — what you're passing right now. */}
              <View style={[styles.card, active && styles.cardActive]}>
                {featured ? (
                  <>
                    <View style={styles.cardHead}>
                      <Text style={styles.cardIcon}>{KIND_ICON[featured.a.kind] ?? "•"}</Text>
                      <Text style={styles.cardWhen}>
                        {active ? "● at this point" : `${fmtDist(featured.dist)} · ${fmtClock(featured.a.t)}`}
                      </Text>
                      <View style={{ flex: 1 }} />
                      <Pressable hitSlop={10} onPress={() => startEdit(featured!.a)}>
                        <Text style={styles.cardEdit}>✎</Text>
                      </Pressable>
                      <Pressable hitSlop={10} onPress={() => confirmDelete(featured!.a)}>
                        <Text style={styles.cardDel}>✕</Text>
                      </Pressable>
                    </View>
                    {featured.a.kind === "photo" && (
                      <Pressable style={styles.media} onPress={() => setPhotoView(featured!.a)}>
                        <PhotoFull a={featured.a} />
                        <Text style={styles.expandHint}>⤢ Tap to expand</Text>
                      </Pressable>
                    )}
                    {featured.a.kind === "voice" && <VoicePlayer a={featured.a} />}
                    {!!featured.a.text && <Text style={styles.cardText}>{featured.a.text}</Text>}
                    {featured.a.kind === "text" && !featured.a.text && <Text style={styles.cardText}>(empty note)</Text>}
                  </>
                ) : (
                  <Text style={styles.cardEmpty}>
                    No annotations on this run yet — scrub the route to relive it, or pin notes from the run screen.
                  </Text>
                )}
              </View>

              {/* Timeline — jump straight to any annotation. */}
              {placed.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.timeline}>
                  {placed.map((p) => {
                    const on = p.a.id === featured?.a.id;
                    return (
                      <Pressable key={p.a.id} style={[styles.chip, on && styles.chipOn]} onPress={() => setD(p.dist)}>
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>
                          {KIND_ICON[p.a.kind] ?? "•"} {fmtDist(p.dist)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              )}
            </>
          )}
        </ScrollView>

        {/* In-place edit of a note's text / a photo·voice caption */}
        <Modal visible={!!editing} transparent animationType="fade" onRequestClose={() => setEditing(null)}>
          <View style={styles.editBackdrop}>
            <View style={styles.editCard}>
              <Text style={styles.editTitle}>
                {editing?.kind === "text" ? "Edit note" : "Caption"}
              </Text>
              <TextInput
                style={styles.editInput}
                value={editText}
                onChangeText={setEditText}
                placeholder={editing?.kind === "text" ? "Note…" : "Add a caption…"}
                placeholderTextColor={theme.textTertiary}
                multiline
                autoFocus
              />
              <View style={styles.editBtns}>
                <Pressable style={[styles.editBtn, { borderColor: theme.border }]} onPress={() => setEditing(null)}>
                  <Text style={styles.editBtnText}>Cancel</Text>
                </Pressable>
                <Pressable style={[styles.editBtn, { backgroundColor: theme.primary, borderColor: theme.primary }]} onPress={saveEdit}>
                  <Text style={[styles.editBtnText, { color: "#1a1206" }]}>Save</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* Full-screen photo viewer */}
        <Modal visible={!!photoView} transparent animationType="fade" onRequestClose={() => setPhotoView(null)}>
          <Pressable style={styles.photoBackdrop} onPress={() => setPhotoView(null)}>
            {photoView && <PhotoFull a={photoView} />}
            <Text style={styles.photoClose}>Tap to close</Text>
          </Pressable>
        </Modal>
      </View>
    </Modal>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statK}>{k}</Text>
      <Text style={styles.statV}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Clear the status bar — the modal fills the screen (as the app's other screens do
  // via SafeAreaView + StatusBar.currentHeight), else the header hides behind it.
  root: { flex: 1, backgroundColor: theme.bg, paddingTop: (StatusBar.currentHeight ?? 0) + 8 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 10 },
  title: { color: theme.text, fontSize: 18, fontWeight: "700", flexShrink: 1, paddingRight: 12 },
  close: { color: theme.primary, fontSize: 16, fontWeight: "600" },
  empty: { color: theme.textTertiary, textAlign: "center", marginTop: 60, fontSize: 15 },
  mapBox: { backgroundColor: theme.elevated, borderRadius: 10, borderWidth: 1, borderColor: theme.border, overflow: "hidden", alignItems: "center", justifyContent: "center", marginHorizontal: 16 },
  hint: { color: theme.textTertiary, fontSize: 12, marginTop: 8, marginHorizontal: 16 },
  zoomRow: { flexDirection: "row", gap: 8, marginTop: 10, marginHorizontal: 16, alignItems: "center" },
  zoomToggle: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border },
  zoomToggleOn: { backgroundColor: theme.elevated, borderColor: theme.primary },
  zoomToggleText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  zoomToggleTextOn: { color: theme.primary },
  zoomBtn: { width: 34, height: 34, borderRadius: 8, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, alignItems: "center", justifyContent: "center" },
  zoomBtnText: { color: theme.text, fontSize: 20, fontWeight: "700", lineHeight: 22 },
  statRow: { flexDirection: "row", justifyContent: "space-around", marginTop: 14, paddingHorizontal: 16 },
  stat: { alignItems: "center" },
  statK: { color: theme.textTertiary, fontSize: 11, letterSpacing: 0.5 },
  statV: { color: theme.text, fontSize: 22, fontWeight: "700", marginTop: 2 },
  elevBox: { backgroundColor: theme.elevated, borderRadius: 10, borderWidth: 1, borderColor: theme.border, overflow: "hidden", marginHorizontal: 16, marginTop: 14 },
  card: { marginHorizontal: 16, marginTop: 16, backgroundColor: theme.card, borderRadius: 12, borderWidth: 1, borderColor: theme.border, padding: 14 },
  cardActive: { borderColor: theme.primary },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  cardIcon: { fontSize: 18 },
  cardWhen: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  cardEdit: { color: theme.textTertiary, fontSize: 16, paddingLeft: 8 },
  cardDel: { color: theme.textTertiary, fontSize: 16, paddingLeft: 12 },
  media: { height: 360, alignItems: "center", justifyContent: "center", marginVertical: 6 },
  expandHint: { position: "absolute", bottom: 6, right: 8, color: "#fff", fontSize: 11, fontWeight: "600", backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: "hidden" },
  cardText: { color: theme.text, fontSize: 15, lineHeight: 21, marginTop: 6 },
  cardEmpty: { color: theme.textTertiary, fontSize: 14, lineHeight: 20 },
  timeline: { paddingHorizontal: 16, paddingVertical: 14, gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border },
  chipOn: { backgroundColor: theme.elevated, borderColor: theme.primary },
  chipText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: theme.primary },
  photoBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.94)", alignItems: "center", justifyContent: "center" },
  photoClose: { color: "#fff", fontSize: 14, marginTop: 16, opacity: 0.8 },
  editBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center", padding: 24 },
  editCard: { backgroundColor: theme.card, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 20, width: "100%", maxWidth: 420 },
  editTitle: { color: theme.text, fontSize: 16, fontWeight: "700", marginBottom: 12 },
  editInput: { backgroundColor: theme.elevated, borderRadius: 10, borderWidth: 1, borderColor: theme.border, color: theme.text, fontSize: 15, paddingHorizontal: 14, paddingVertical: 12, minHeight: 80, textAlignVertical: "top" },
  editBtns: { flexDirection: "row", gap: 12, marginTop: 16 },
  editBtn: { flex: 1, borderWidth: 1, borderRadius: 12, paddingVertical: 13, alignItems: "center" },
  editBtnText: { color: theme.text, fontSize: 15, fontWeight: "700" },
});
