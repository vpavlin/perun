// "Share video" — render a run's Replay to a shareable WebM, fully offline.
//
// The renderer (lib/replayVideoHtml) runs in a WebView: it draws the run on a canvas
// (cinematic black-BG "route draws itself") and records it with MediaRecorder. We assemble
// the run payload (track points + annotations + LOCAL photos embedded as data URIs — no
// network, no map tiles), hand it to the WebView after its "ready", stream progress, then
// write the returned WebM to a file and open the share sheet.
import React, { useEffect, useRef, useState } from "react";
import {
  Alert, Dimensions, Modal, PanResponder, Pressable, StyleSheet, Text, View,
} from "react-native";
import { WebView } from "react-native-webview";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { fromByteArray, toByteArray } from "base64-js";
import { Run } from "../lib/types";
import { Annotation, useAnnotations } from "../lib/annotations";
import { localBlobUri, readFileBytes } from "../lib/blob";
import { replayVideoHtml } from "../lib/replayVideoHtml";
import { theme } from "../theme";

const MAX_PHOTOS = 6; // bound the embedded payload + canvas work
const BASE_TRAVEL = 12; // seconds of cruise across the whole route at pace 1.0
const PACE = { min: 0.6, max: 2.4 }; // higher = faster = shorter clip

// prep = building/prepping; ready = prepared, waiting for Start; then rendering → saving.
type Phase = "prep" | "ready" | "rendering" | "saving" | "done" | "error" | "unsupported";

/** Estimated clip length (s) for a pace — matches the renderer's schedule formula. */
function estimateDuration(annotations: Annotation[], pace: number): number {
  let read = 0;
  for (const a of annotations) {
    if (a.kind === "text" || a.kind === "photo") read += 3;
    else if (a.kind === "voice") read += Math.max(3, (a.dur || 3) + 0.8);
  }
  return 0.9 + BASE_TRAVEL / pace + read + 2.4;
}

/** Read a locally-held blob and return a data: URI, or null if we don't have it. */
async function blobDataUri(a: Annotation, fallbackMime: string): Promise<string | null> {
  if (!a.blobId) return null;
  const mime = a.mime || fallbackMime;
  const uri = localBlobUri(a.blobId, mime);
  if (!uri) return null; // only embed what's on THIS device (offline)
  try {
    const bytes = await readFileBytes(uri);
    return `data:${mime};base64,${fromByteArray(bytes)}`;
  } catch {
    return null;
  }
}

// Aspect-ratio presets — pick the frame for the destination platform.
const RATIOS: Record<string, { w: number; h: number; label: string; hint: string }> = {
  square:    { w: 900,  h: 900,  label: "1:1",  hint: "Instagram" },
  landscape: { w: 1280, h: 720,  label: "16:9", hint: "YouTube" },
  portrait:  { w: 720,  h: 1280, label: "9:16", hint: "TikTok · Reels · Shorts" },
};

/** Build the JSON the WebView renderer consumes. */
async function buildPayload(run: Run, annotations: Annotation[], dims: { w: number; h: number }, pace: number) {
  const points = run.track.points.map((p) => ({ lat: p.lat, lon: p.lon, alt: p.alt ?? 0, t: p.t }));
  let photos = 0;
  const anns = [];
  for (const a of annotations) {
    if (a.kind !== "text" && a.kind !== "photo" && a.kind !== "voice") continue;
    let img: string | undefined;
    let audio: string | undefined;
    if (a.kind === "photo" && photos < MAX_PHOTOS) {
      const u = await blobDataUri(a, "image/jpeg");
      if (u) { img = u; photos++; }
    }
    if (a.kind === "voice") {
      const u = await blobDataUri(a, "audio/m4a"); // played into the video at its dwell
      if (u) audio = u;
    }
    anns.push({ t: a.t, kind: a.kind, text: a.text || "", dur: a.dur, img, audio });
  }
  // Scale the bitrate with the frame so bigger ratios don't look soft (capped for the bridge).
  const bitrate = Math.min(6_500_000, Math.round(4_000_000 * (Math.max(dims.w, dims.h) / 900)));
  return {
    name: run.name,
    points,
    annotations: anns,
    // travelS = cruise time across the whole route (pace scales it). The playhead
    // decelerates into / crawls through / accelerates out of each annotation (readS, or a
    // voice note's length) — a smooth slow-through, not a hard stop.
    opts: { travelS: BASE_TRAVEL / pace, readS: 3, width: dims.w, height: dims.h, bitrate },
  };
}

export function ReplayVideo({ run, visible, onClose }: { run: Run; visible: boolean; onClose: () => void }) {
  const annotations = useAnnotations(run.id);
  const webRef = useRef<WebView>(null);
  const payloadRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>("prep");
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string>("");
  const [ratioKey, setRatioKey] = useState<string>("square");
  const ratio = RATIOS[ratioKey];
  const [pace, setPace] = useState(1);         // committed pace (triggers a re-prep)
  const [paceLive, setPaceLive] = useState(1); // live while dragging (display only)
  const [est, setEst] = useState(0);           // accurate estimate from the renderer

  // Rebuild the payload + re-prep whenever the sheet opens, the ratio, or committed pace
  // changes. Clearing payloadRef ensures the WebView (which remounts) injects the fresh one.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    payloadRef.current = null;
    setPhase("prep"); setProgress(0); setErr("");
    setEst(estimateDuration(annotations, pace));
    buildPayload(run, annotations, { w: ratio.w, h: ratio.h }, pace).then((p) => {
      if (alive) payloadRef.current = JSON.stringify(p);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, run.id, ratioKey, pace]);

  const shareWebm = async (dataUrl: string) => {
    setPhase("saving");
    try {
      const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const bytes = toByteArray(b64);
      const safe = run.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "run";
      const file = new File(Paths.cache, `perun-${safe}.webm`);
      try { if (file.exists) file.delete(); } catch { /* ignore */ }
      file.write(bytes);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Saved", `Video saved to:\n${file.uri}`);
      } else {
        await Sharing.shareAsync(file.uri, { mimeType: "video/webm", dialogTitle: `${run.name} — Replay` });
      }
      setPhase("done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  const startRender = () => {
    webRef.current?.injectJavaScript("window.__start&&window.__start();true;");
    setProgress(0); setPhase("rendering");
  };
  const cancelRender = () => {
    webRef.current?.injectJavaScript("window.__cancel&&window.__cancel();true;");
  };

  const onMessage = (raw: string) => {
    let m: { type?: string; p?: number; dataUrl?: string; msg?: string; durationS?: number };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "ready") {
      // Hand the (already-built) payload to the renderer to PREP. Retry if not ready yet.
      const send = (n: number) => {
        const p = payloadRef.current;
        if (!p) { if (n > 0) setTimeout(() => send(n - 1), 150); return; }
        webRef.current?.injectJavaScript(`window.__setRun(${JSON.stringify(p)});true;`);
      };
      send(25);
    } else if (m.type === "prepared") {
      if (typeof m.durationS === "number") setEst(m.durationS);
      setPhase("ready");
    } else if (m.type === "progress") {
      setProgress(typeof m.p === "number" ? m.p : 0);
    } else if (m.type === "done" && m.dataUrl) {
      void shareWebm(m.dataUrl);
    } else if (m.type === "cancelled") {
      setProgress(0); setPhase("ready");
    } else if (m.type === "error") {
      setErr(m.msg || "render failed");
      setPhase(/support/i.test(m.msg || "") ? "unsupported" : "error");
    }
  };

  // Fit the stage to the chosen aspect within the available area (preview only; the
  // recorded resolution is the payload's width/height).
  const win = Dimensions.get("window");
  const availW = win.width - 32;
  const availH = win.height * 0.54;
  const scale = Math.min(availW / ratio.w, availH / ratio.h);
  const sw = Math.round(ratio.w * scale);
  const sh = Math.round(ratio.h * scale);
  const busy = phase === "rendering" || phase === "saving";

  const label =
    phase === "prep" ? "Preparing…"
    : phase === "ready" ? `Ready · ~${Math.round(est)}s`
    : phase === "rendering" ? `Rendering… ${Math.round(progress * 100)}%`
    : phase === "saving" ? "Saving + sharing…"
    : phase === "done" ? "Shared ✓ — adjust and render again"
    : phase === "unsupported" ? "This device's WebView can't record video"
    : phase === "error" ? `Failed: ${err}`
    : "";
  const estShown = busy ? est : estimateDuration(annotations, paceLive);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>Replay video · {run.name}</Text>
          <Pressable onPress={onClose} hitSlop={12}><Text style={styles.close}>Done</Text></Pressable>
        </View>

        {/* Aspect-ratio picker — each re-renders the clip at that frame. */}
        <View style={styles.ratios}>
          {Object.keys(RATIOS).map((k) => {
            const r = RATIOS[k]; const on = k === ratioKey;
            return (
              <Pressable
                key={k}
                style={[styles.ratioChip, on && styles.ratioChipOn, busy && styles.ratioDisabled]}
                disabled={busy}
                onPress={() => setRatioKey(k)}
              >
                <Text style={[styles.ratioLabel, on && styles.ratioLabelOn]}>{r.label}</Text>
                <Text style={styles.ratioHint}>{r.hint}</Text>
              </Pressable>
            );
          })}
        </View>

        {/* WebView renders the animation live (visible so rAF isn't throttled) and records
            it — preview + encoder in one. key=ratio remounts it for a fresh render. */}
        <View style={[styles.stage, { width: sw, height: sh }]}>
          {visible && (
            <WebView
              key={`${ratioKey}-${pace.toFixed(2)}`}
              ref={webRef}
              source={{ html: replayVideoHtml() }}
              originWhitelist={["*"]}
              javaScriptEnabled
              domStorageEnabled
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              onMessage={(e) => onMessage(e.nativeEvent.data)}
              style={{ backgroundColor: "#000" }}
            />
          )}
        </View>

        {/* Pace / length — slide to control how long the clip is (live estimate). */}
        <View style={styles.paceRow}>
          <Text style={styles.paceCap}>Longer</Text>
          <PaceSlider
            value={paceLive}
            disabled={busy}
            onLive={setPaceLive}
            onCommit={(v) => { setPaceLive(v); setPace(v); }}
          />
          <Text style={styles.paceCap}>Shorter</Text>
          <Text style={styles.paceEst}>~{Math.round(estShown)}s</Text>
        </View>

        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
        <Text style={styles.status}>{label}</Text>

        <View style={styles.controls}>
          {phase === "rendering" ? (
            <Pressable style={[styles.btn, styles.btnCancel]} onPress={cancelRender}>
              <Text style={styles.btnCancelText}>Cancel</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.btn, styles.btnPrimary, (phase === "prep" || phase === "saving") && styles.btnDisabled]}
              disabled={phase === "prep" || phase === "saving"}
              onPress={startRender}
            >
              <Text style={styles.btnPrimaryText}>{phase === "done" ? "● Render again" : "● Start render"}</Text>
            </Pressable>
          )}
        </View>
        {(phase === "prep" || phase === "ready" || phase === "rendering") && (
          <Text style={styles.hint}>Pick a frame + pace, then Start. Keep the app in the foreground while it renders — all on-device, no network.</Text>
        )}
      </View>
    </Modal>
  );
}

/** A minimal pace slider (no native dep). Reports live value while dragging, commits on
 *  release (which triggers a re-prep). Left = longer clip, right = shorter. */
function PaceSlider({ value, onLive, onCommit, disabled }: {
  value: number; onLive: (v: number) => void; onCommit: (v: number) => void; disabled?: boolean;
}) {
  const wRef = useRef(1);
  const toVal = (x: number) => {
    const t = Math.max(0, Math.min(1, x / Math.max(1, wRef.current)));
    return PACE.min + t * (PACE.max - PACE.min);
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: () => !disabled,
      onPanResponderGrant: (e) => onLive(toVal(e.nativeEvent.locationX)),
      onPanResponderMove: (e) => onLive(toVal(e.nativeEvent.locationX)),
      onPanResponderRelease: (e) => onCommit(toVal(e.nativeEvent.locationX)),
    })
  ).current;
  const t = (value - PACE.min) / (PACE.max - PACE.min);
  return (
    <View
      style={[styles.sliderTrack, disabled && styles.ratioDisabled]}
      onLayout={(e) => { wRef.current = e.nativeEvent.layout.width; }}
      {...pan.panHandlers}
    >
      <View style={styles.sliderBase} />
      <View style={[styles.sliderFill, { width: `${t * 100}%` }]} />
      <View style={[styles.sliderThumb, { left: `${t * 100}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingTop: 8 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 10 },
  title: { color: theme.text, fontSize: 18, fontWeight: "700", flexShrink: 1, paddingRight: 12 },
  close: { color: theme.primary, fontSize: 16, fontWeight: "600" },
  ratios: { flexDirection: "row", gap: 8, justifyContent: "center", paddingHorizontal: 16, marginBottom: 12 },
  ratioChip: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 11, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border },
  ratioChipOn: { backgroundColor: theme.elevated, borderColor: theme.primary },
  ratioDisabled: { opacity: 0.45 },
  ratioLabel: { color: theme.textSecondary, fontSize: 15, fontWeight: "700" },
  ratioLabelOn: { color: theme.primary },
  ratioHint: { color: theme.textTertiary, fontSize: 10, marginTop: 2 },
  paceRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, marginTop: 14 },
  paceCap: { color: theme.textTertiary, fontSize: 11 },
  paceEst: { color: theme.text, fontSize: 13, fontWeight: "700", minWidth: 42, textAlign: "right" },
  sliderTrack: { flex: 1, height: 26, justifyContent: "center" },
  sliderBase: { position: "absolute", left: 0, right: 0, top: 11, height: 4, borderRadius: 2, backgroundColor: theme.border },
  sliderFill: { position: "absolute", left: 0, top: 11, height: 4, borderRadius: 2, backgroundColor: theme.primary },
  sliderThumb: { position: "absolute", width: 18, height: 18, borderRadius: 9, marginLeft: -9, backgroundColor: theme.primary, borderWidth: 2, borderColor: theme.bg, top: 4 },
  controls: { paddingHorizontal: 16, marginTop: 14 },
  btn: { borderRadius: 13, paddingVertical: 15, alignItems: "center" },
  btnPrimary: { backgroundColor: theme.primary },
  btnPrimaryText: { color: "#1a1206", fontSize: 16, fontWeight: "800" },
  btnCancel: { borderWidth: 1, borderColor: theme.error },
  btnCancelText: { color: theme.error, fontSize: 16, fontWeight: "700" },
  btnDisabled: { opacity: 0.45 },
  stage: { backgroundColor: "#000", alignSelf: "center" },
  bar: { height: 4, backgroundColor: theme.card, marginHorizontal: 16, marginTop: 18, borderRadius: 2, overflow: "hidden" },
  barFill: { height: 4, backgroundColor: theme.primary },
  status: { color: theme.text, fontSize: 15, fontWeight: "600", textAlign: "center", marginTop: 12 },
  hint: { color: theme.textTertiary, fontSize: 12, textAlign: "center", marginTop: 8, paddingHorizontal: 24, lineHeight: 18 },
});
