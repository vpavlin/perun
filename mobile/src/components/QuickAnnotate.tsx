// Live capture bar for the recording screen: drop a text note, photo, or voice memo
// pinned to WHERE YOU ARE RIGHT NOW (the latest recorded fix) without leaving the run.
// This is the "annotate here, now" flow — the saved-run composer (RunAnnotations) is
// for going back over a finished run. Both share the local-first useCapture hook, so a
// note is stored on the device immediately and never depends on a server or pairing.
import React, { useState } from "react";
import {
  ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View,
} from "react-native";
import { GeoPoint } from "../lib/types";
import { useAnnotations } from "../lib/annotations";
import { useCapture } from "../lib/useCapture";
import { theme } from "../theme";

export function QuickAnnotate({
  runId, point, track = [], title = "ANNOTATE HERE", emptyHint = "Waiting for the first GPS fix…",
}: {
  runId: string;
  /** Where a new annotation is pinned — the live fix while recording, or the Replay
   *  playhead. Null disables capture (nothing to pin to yet). */
  point: GeoPoint | null;
  /** The run's track, so a photo's EXIF geodata can place its pin. */
  track?: GeoPoint[];
  title?: string;
  emptyHint?: string;
}) {
  const cap = useCapture(runId, track);
  const count = useAnnotations(runId).length;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  // Resolve the pin at the moment you tap, so it lands exactly where the caller points.
  const here = (): GeoPoint | null => point;
  const ready = !!point && !cap.busy;

  const onNote = async () => {
    const p = here();
    if (!p) return;
    if (await cap.addText(text, p)) setText("");
  };
  const onPhoto = () => {
    const p = here();
    if (!p) return;
    setOpen(false);
    void cap.addPhoto(false, p, text).then(() => setText(""));
  };
  const onCamera = () => {
    const p = here();
    if (!p) return;
    setOpen(false);
    void cap.addPhoto(true, p, text).then(() => setText(""));
  };
  const onStopVoice = async () => {
    const p = here();
    if (!p) { await cap.cancelVoice(); return; }
    await cap.stopVoice(p, text);
    setText("");
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.headRow}>
        <Text style={styles.label}>{title}</Text>
        {count > 0 && <Text style={styles.count}>{count} pinned</Text>}
      </View>
      <TextInput
        style={styles.input}
        placeholder="A note for this spot (or a caption)…"
        placeholderTextColor={theme.textTertiary}
        value={text}
        onChangeText={setText}
      />
      <View style={styles.row}>
        <Pressable style={[styles.btn, (!ready || !text.trim()) && styles.btnOff]} onPress={onNote} disabled={!ready || !text.trim()}>
          <Text style={styles.btnText}>💬 Note</Text>
        </Pressable>
        <Pressable style={[styles.btn, !ready && styles.btnOff]} onPress={() => setOpen(true)} disabled={!ready}>
          <Text style={styles.btnText}>📷 Photo</Text>
        </Pressable>
        <Pressable style={[styles.btn, !ready && styles.btnOff]} onPress={() => void cap.startVoice()} disabled={!ready}>
          <Text style={styles.btnText}>🎙 Voice</Text>
        </Pressable>
      </View>
      {!point && <Text style={styles.hint}>{emptyHint}</Text>}
      {!!cap.busy && (
        <View style={styles.busyRow}>
          <ActivityIndicator color={theme.primary} size="small" />
          <Text style={styles.busyText}>{cap.busy}</Text>
        </View>
      )}

      {/* Photo source chooser (kept in-component so the recording screen owns no Alert). */}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Add photo</Text>
            <Pressable style={styles.sheetBtn} onPress={onCamera}><Text style={styles.sheetBtnText}>Camera</Text></Pressable>
            <Pressable style={styles.sheetBtn} onPress={onPhoto}><Text style={styles.sheetBtnText}>Library</Text></Pressable>
            <Pressable style={[styles.sheetBtn, styles.sheetCancel]} onPress={() => setOpen(false)}>
              <Text style={styles.sheetBtnText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Voice recording overlay */}
      <Modal visible={cap.recording} transparent animationType="fade" onRequestClose={() => void cap.cancelVoice()}>
        <View style={styles.backdrop}>
          <View style={styles.recCard}>
            <Text style={styles.recDot}>● Recording…</Text>
            <Text style={styles.recHint}>Speak your note, then stop to pin it here.</Text>
            <View style={styles.recBtns}>
              <Pressable style={[styles.recBtn, { borderColor: theme.border }]} onPress={() => void cap.cancelVoice()}>
                <Text style={styles.recBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.recBtn, { backgroundColor: theme.primary, borderColor: theme.primary }]} onPress={onStopVoice}>
                <Text style={[styles.recBtnText, { color: "#1a1206" }]}>Stop + pin</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 20, paddingHorizontal: 16 },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  label: { color: theme.textTertiary, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  count: { color: theme.primary, fontSize: 12, fontWeight: "700" },
  input: {
    backgroundColor: theme.card, borderRadius: 10, borderWidth: 1, borderColor: theme.border,
    color: theme.text, fontSize: 15, paddingHorizontal: 14, paddingVertical: 10, minHeight: 44,
  },
  row: { flexDirection: "row", gap: 8, marginTop: 10 },
  btn: { flex: 1, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingVertical: 11, alignItems: "center", backgroundColor: theme.card },
  btnOff: { opacity: 0.4 },
  btnText: { color: theme.text, fontSize: 14, fontWeight: "600" },
  hint: { color: theme.textTertiary, fontSize: 12, marginTop: 8 },
  busyRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  busyText: { color: theme.textSecondary, fontSize: 13 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center", padding: 24 },
  sheet: { backgroundColor: theme.card, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 16, width: "100%", maxWidth: 380 },
  sheetTitle: { color: theme.text, fontSize: 16, fontWeight: "700", textAlign: "center", marginBottom: 12 },
  sheetBtn: { borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 8 },
  sheetCancel: { borderColor: theme.border, opacity: 0.8 },
  sheetBtnText: { color: theme.text, fontSize: 15, fontWeight: "600" },
  recCard: { backgroundColor: theme.card, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 24, width: "100%", maxWidth: 380 },
  recDot: { color: theme.error, fontSize: 20, fontWeight: "800", textAlign: "center" },
  recHint: { color: theme.textSecondary, fontSize: 14, textAlign: "center", marginTop: 10 },
  recBtns: { flexDirection: "row", gap: 12, marginTop: 20 },
  recBtn: { flex: 1, borderWidth: 1, borderRadius: 12, paddingVertical: 13, alignItems: "center" },
  recBtnText: { color: theme.text, fontSize: 15, fontWeight: "700" },
});
