// Journey annotations UI: capture (text / photo / voice) + a pinned list + route
// markers, for one saved run. Photos/voice are sealed and uploaded to the blob server
// (blob.ts); only the small metadata syncs over Delivery. Everything is offline-first —
// a text note is authored+stored locally with no server at all.
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator, Alert, Dimensions, Image, Modal, Pressable, StyleSheet, Text, TextInput, View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  useAudioRecorder, useAudioPlayer, useAudioPlayerStatus, RecordingPresets,
  requestRecordingPermissionsAsync, setAudioModeAsync,
} from "expo-audio";
import { GeoPoint } from "../lib/types";
import {
  Annotation, AnnotationKind, useAnnotations, authorAnnotation, deleteAnnotation,
} from "../lib/annotations";
import { readFileBytes, uploadBlob, fetchBlob } from "../lib/blob";
import { getDeviceId } from "../lib/delivery";
import { RouteMap } from "./RouteMap";
import { theme } from "../theme";

const W = () => Dimensions.get("window").width - 32;

const KIND_ICON: Record<AnnotationKind, string> = {
  text: "💬", photo: "📷", voice: "🎙️", delete: "🗑",
};

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function RunAnnotations({ run }: { run: { id: string; track: { points: GeoPoint[] } } }) {
  const annotations = useAnnotations(run.id);
  const points = run.track.points;
  const lastPoint = points[points.length - 1];

  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [pickPoint, setPickPoint] = useState<GeoPoint | null>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [photoView, setPhotoView] = useState<Annotation | null>(null);

  useEffect(() => { getDeviceId().then(setDeviceId).catch(() => {}); }, []);

  // Voice recorder (hook must be unconditional). Recording UI is gated by `recording`.
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recStartRef = React.useRef(0);

  const targetPoint = pickPoint ?? lastPoint;
  const w = W();

  const markers = annotations.map((a) => ({ id: a.id, lat: a.lat, lon: a.lon, kind: a.kind }));

  const resetComposer = () => { setText(""); setCaption(""); setPickPoint(null); setPickMode(false); };

  const addText = async () => {
    const body = text.trim();
    if (!body || !targetPoint) return;
    setBusy("Saving note…");
    try {
      await authorAnnotation({ runId: run.id, point: targetPoint, kind: "text", text: body });
      resetComposer();
    } catch (e) {
      Alert.alert("Couldn't save note", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const addPhoto = async (fromCamera: boolean) => {
    if (!targetPoint) return;
    try {
      const perm = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", fromCamera ? "Camera access is off." : "Photo access is off.");
        return;
      }
      const res = fromCamera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.7 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.7 });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      const mime = asset.mimeType || "image/jpeg";
      setBusy("Sealing + uploading photo…");
      const bytes = await readFileBytes(asset.uri);
      const blobId = await uploadBlob(bytes, mime);
      await authorAnnotation({
        runId: run.id, point: targetPoint, kind: "photo", blobId, mime,
        text: caption.trim() || undefined,
      });
      resetComposer();
    } catch (e) {
      Alert.alert("Photo failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const pickPhoto = () => {
    Alert.alert("Add photo", "Where from?", [
      { text: "Camera", onPress: () => addPhoto(true) },
      { text: "Library", onPress: () => addPhoto(false) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const startVoice = async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) { Alert.alert("Microphone off", "Enable microphone access to record a voice note."); return; }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recStartRef.current = Date.now();
      setRecording(true);
    } catch (e) {
      Alert.alert("Can't record", e instanceof Error ? e.message : String(e));
    }
  };

  const stopVoice = async () => {
    if (!targetPoint) { setRecording(false); return; }
    setRecording(false);
    setBusy("Sealing + uploading voice…");
    try {
      await recorder.stop();
      const uri = recorder.uri;
      const dur = Math.max(1, Math.round((Date.now() - recStartRef.current) / 1000));
      if (!uri) throw new Error("No recording produced");
      const mime = "audio/m4a";
      const bytes = await readFileBytes(uri);
      const blobId = await uploadBlob(bytes, mime);
      await authorAnnotation({
        runId: run.id, point: targetPoint, kind: "voice", blobId, mime, dur,
        text: caption.trim() || undefined,
      });
      resetComposer();
    } catch (e) {
      Alert.alert("Voice failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const cancelVoice = async () => {
    setRecording(false);
    try { await recorder.stop(); } catch { /* ignore */ }
  };

  const confirmDelete = (a: Annotation) => {
    Alert.alert("Delete annotation?", "This removes it for everyone (an append-only tombstone).", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => { void deleteAnnotation(a); } },
    ]);
  };

  return (
    <View style={{ marginTop: 24 }}>
      <Text style={styles.sectionLabel}>ANNOTATIONS</Text>

      {/* Map with pins. Tap "Pin a spot" to place the next note on a chosen point. */}
      <View style={[styles.mapBox, { width: w, height: 200 }]}>
        <RouteMap
          points={points}
          width={w}
          height={200}
          markers={markers}
          onMarkerPress={setHighlightId}
          highlightId={highlightId ?? undefined}
          pickMode={pickMode}
          onPickPoint={(p) => { setPickPoint(p); setPickMode(false); }}
          pickedPoint={pickPoint}
        />
      </View>
      <View style={styles.pickRow}>
        <Pressable
          style={[styles.pickBtn, pickMode && styles.pickBtnOn]}
          onPress={() => setPickMode((v) => !v)}
        >
          <Text style={[styles.pickText, pickMode && styles.pickTextOn]}>
            {pickMode ? "Tap the route…" : pickPoint ? "◎ Point set" : "◍ Pin a spot"}
          </Text>
        </Pressable>
        <Text style={styles.pickHint}>
          {pickPoint ? `${fmtClock(pickPoint.t)} on route` : "defaults to the finish"}
        </Text>
      </View>

      {/* Composer: a caption/text field shared by all three kinds. */}
      <TextInput
        style={styles.input}
        placeholder="Note, or a caption for a photo/voice…"
        placeholderTextColor={theme.textTertiary}
        value={text || caption}
        onChangeText={(v) => { setText(v); setCaption(v); }}
        multiline
      />
      <View style={styles.actionRow}>
        <Pressable style={styles.actionBtn} onPress={addText} disabled={!!busy || !text.trim()}>
          <Text style={styles.actionText}>💬 Note</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={pickPhoto} disabled={!!busy}>
          <Text style={styles.actionText}>📷 Photo</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={startVoice} disabled={!!busy}>
          <Text style={styles.actionText}>🎙 Voice</Text>
        </Pressable>
      </View>
      {!!busy && (
        <View style={styles.busyRow}>
          <ActivityIndicator color={theme.primary} size="small" />
          <Text style={styles.busyText}>{busy}</Text>
        </View>
      )}

      {/* List — chronological, tombstones already applied by useAnnotations. */}
      {annotations.length === 0 ? (
        <Text style={styles.empty}>No annotations yet. Pin a note, photo, or voice memo to a spot on the route.</Text>
      ) : (
        annotations.map((a) => (
          <AnnotationRow
            key={a.id}
            a={a}
            mine={a.author === deviceId}
            highlighted={a.id === highlightId}
            onFocus={() => setHighlightId(a.id)}
            onOpenPhoto={() => setPhotoView(a)}
            onDelete={() => confirmDelete(a)}
          />
        ))
      )}

      {/* Voice-recording overlay */}
      <Modal visible={recording} transparent animationType="fade" onRequestClose={cancelVoice}>
        <View style={styles.recBackdrop}>
          <View style={styles.recCard}>
            <Text style={styles.recDot}>● Recording…</Text>
            <Text style={styles.recHint}>Speak your note, then stop to seal + upload.</Text>
            <View style={styles.recBtns}>
              <Pressable style={[styles.recBtn, { borderColor: theme.border }]} onPress={cancelVoice}>
                <Text style={styles.recBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.recBtn, { backgroundColor: theme.primary, borderColor: theme.primary }]} onPress={stopVoice}>
                <Text style={[styles.recBtnText, { color: "#1a1206" }]}>Stop + save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Full-screen photo view */}
      <Modal visible={!!photoView} transparent animationType="fade" onRequestClose={() => setPhotoView(null)}>
        <Pressable style={styles.photoBackdrop} onPress={() => setPhotoView(null)}>
          {photoView && <PhotoFull a={photoView} />}
          <Text style={styles.photoClose}>Tap to close</Text>
        </Pressable>
      </Modal>
    </View>
  );
}

// One list row. Photo shows a thumbnail; voice shows a play button; text just text.
function AnnotationRow({
  a, mine, highlighted, onFocus, onOpenPhoto, onDelete,
}: {
  a: Annotation; mine: boolean; highlighted: boolean;
  onFocus: () => void; onOpenPhoto: () => void; onDelete: () => void;
}) {
  return (
    <Pressable
      style={[styles.row, highlighted && styles.rowOn]}
      onPress={onFocus}
      onLongPress={mine ? onDelete : undefined}
    >
      <Text style={styles.rowIcon}>{KIND_ICON[a.kind]}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTime}>{fmtClock(a.t)}{mine ? "" : " · shared"}</Text>
        {a.kind === "photo" && <PhotoThumb a={a} onPress={onOpenPhoto} />}
        {a.kind === "voice" && <VoicePlayer a={a} />}
        {!!a.text && <Text style={styles.rowText}>{a.text}</Text>}
        {a.kind === "text" && !a.text && <Text style={styles.rowText}>(empty note)</Text>}
      </View>
      {mine && (
        <Pressable hitSlop={10} onPress={onDelete}>
          <Text style={styles.rowDel}>✕</Text>
        </Pressable>
      )}
    </Pressable>
  );
}

// Lazy-fetch + decrypt a blob to a local uri (cached by blobId). null while loading /
// on failure (server unreachable) — callers show a placeholder.
function useBlobUri(blobId?: string, mime?: string): { uri: string | null; failed: boolean; loading: boolean } {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(!!blobId);
  useEffect(() => {
    if (!blobId) { setLoading(false); return; }
    let alive = true;
    setLoading(true); setFailed(false);
    fetchBlob(blobId, mime || "").then((u) => {
      if (!alive) return;
      setUri(u);
      setFailed(!u);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [blobId, mime]);
  return { uri, failed, loading };
}

function PhotoThumb({ a, onPress }: { a: Annotation; onPress: () => void }) {
  const { uri, failed, loading } = useBlobUri(a.blobId, a.mime);
  if (loading) return <View style={styles.thumb}><ActivityIndicator color={theme.primary} size="small" /></View>;
  if (!uri || failed) return <View style={styles.thumb}><Text style={styles.thumbPh}>photo offline</Text></View>;
  return (
    <Pressable onPress={onPress}>
      <Image source={{ uri }} style={styles.thumb} resizeMode="cover" />
    </Pressable>
  );
}

function PhotoFull({ a }: { a: Annotation }) {
  const { uri, failed, loading } = useBlobUri(a.blobId, a.mime);
  if (loading) return <ActivityIndicator color="#fff" />;
  if (!uri || failed) return <Text style={styles.photoClose}>Photo unavailable (server unreachable)</Text>;
  return <Image source={{ uri }} style={styles.photoFull} resizeMode="contain" />;
}

function VoicePlayer({ a }: { a: Annotation }) {
  const { uri, failed, loading } = useBlobUri(a.blobId, a.mime);
  const player = useAudioPlayer(uri ?? undefined);
  const status = useAudioPlayerStatus(player);
  const toggle = () => {
    if (!uri) return;
    if (status.playing) player.pause();
    else { if (status.didJustFinish || status.currentTime >= (status.duration || 0)) player.seekTo(0); player.play(); }
  };
  if (loading) return <View style={styles.voice}><ActivityIndicator color={theme.primary} size="small" /></View>;
  if (!uri || failed) return <View style={styles.voice}><Text style={styles.thumbPh}>voice offline</Text></View>;
  return (
    <Pressable style={styles.voice} onPress={toggle}>
      <Text style={styles.voiceBtn}>{status.playing ? "⏸" : "▶"}</Text>
      <Text style={styles.voiceLabel}>Voice note{a.dur ? ` · ${a.dur}s` : ""}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { color: theme.textTertiary, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginBottom: 8 },
  mapBox: { backgroundColor: theme.elevated, borderRadius: 10, borderWidth: 1, borderColor: theme.border, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  pickRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
  pickBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border },
  pickBtnOn: { backgroundColor: theme.elevated, borderColor: theme.primary },
  pickText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  pickTextOn: { color: theme.primary },
  pickHint: { color: theme.textTertiary, fontSize: 12 },
  input: {
    backgroundColor: theme.card, borderRadius: 10, borderWidth: 1, borderColor: theme.border,
    color: theme.text, fontSize: 15, paddingHorizontal: 14, paddingVertical: 12, marginTop: 12, minHeight: 44,
  },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  actionBtn: { flex: 1, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingVertical: 11, alignItems: "center", backgroundColor: theme.card },
  actionText: { color: theme.text, fontSize: 14, fontWeight: "600" },
  busyRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  busyText: { color: theme.textSecondary, fontSize: 13 },
  empty: { color: theme.textTertiary, fontSize: 14, marginTop: 16, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: theme.card, borderRadius: 10, borderWidth: 1, borderColor: theme.border, padding: 12, marginTop: 10 },
  rowOn: { borderColor: theme.primary },
  rowIcon: { fontSize: 18, marginTop: 1 },
  rowTime: { color: theme.textTertiary, fontSize: 11, marginBottom: 4 },
  rowText: { color: theme.text, fontSize: 15, marginTop: 6, lineHeight: 20 },
  rowDel: { color: theme.textTertiary, fontSize: 16, paddingLeft: 6 },
  thumb: { width: 120, height: 120, borderRadius: 8, backgroundColor: theme.elevated, alignItems: "center", justifyContent: "center" },
  thumbPh: { color: theme.textTertiary, fontSize: 12 },
  voice: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.elevated, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, alignSelf: "flex-start" },
  voiceBtn: { color: theme.primary, fontSize: 18, fontWeight: "700" },
  voiceLabel: { color: theme.text, fontSize: 14 },
  recBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center", padding: 24 },
  recCard: { backgroundColor: theme.card, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 24, width: "100%", maxWidth: 380 },
  recDot: { color: theme.error, fontSize: 20, fontWeight: "800", textAlign: "center" },
  recHint: { color: theme.textSecondary, fontSize: 14, textAlign: "center", marginTop: 10 },
  recBtns: { flexDirection: "row", gap: 12, marginTop: 20 },
  recBtn: { flex: 1, borderWidth: 1, borderRadius: 12, paddingVertical: 13, alignItems: "center" },
  recBtnText: { color: theme.text, fontSize: 15, fontWeight: "700" },
  photoBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
  photoFull: { width: "100%", height: "80%" },
  photoClose: { color: "#fff", fontSize: 14, marginTop: 16, opacity: 0.8 },
});
