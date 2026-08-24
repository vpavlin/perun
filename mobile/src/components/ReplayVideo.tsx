// "Share video" — render a run's Replay to a shareable WebM, fully offline.
//
// The renderer (lib/replayVideoHtml) runs in a WebView: it draws the run on a canvas
// (cinematic black-BG "route draws itself") and records it with MediaRecorder. We assemble
// the run payload (track points + annotations + LOCAL photos embedded as data URIs — no
// network, no map tiles), hand it to the WebView after its "ready", stream progress, then
// write the returned WebM to a file and open the share sheet.
import React, { useEffect, useRef, useState } from "react";
import {
  Alert, Dimensions, Modal, Pressable, StyleSheet, Text, View,
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

type Phase = "prep" | "rendering" | "saving" | "done" | "error" | "unsupported";

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
async function buildPayload(run: Run, annotations: Annotation[], dims: { w: number; h: number }) {
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
    // The clip pauses (dwells) at each annotation so it's readable; a voice dwell stretches
    // to the note's length. travel = glide time across the whole route.
    opts: { travelS: 9, dwellS: 3, dwellCap: 16, width: dims.w, height: dims.h, bitrate },
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

  // Rebuild the payload whenever the sheet opens or the aspect ratio changes. Clearing
  // payloadRef first ensures the WebView (which remounts per ratio) injects the fresh one.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    payloadRef.current = null;
    setPhase("prep"); setProgress(0); setErr("");
    buildPayload(run, annotations, { w: ratio.w, h: ratio.h }).then((p) => {
      if (alive) payloadRef.current = JSON.stringify(p);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, run.id, ratioKey]);

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

  const onMessage = (raw: string) => {
    let m: { type?: string; p?: number; dataUrl?: string; msg?: string };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "ready") {
      // Hand the (already-built) payload to the renderer. Retry briefly if not ready yet.
      const send = (n: number) => {
        const p = payloadRef.current;
        if (!p) { if (n > 0) setTimeout(() => send(n - 1), 150); return; }
        webRef.current?.injectJavaScript(`window.__setRun(${JSON.stringify(p)});true;`);
        setPhase("rendering");
      };
      send(20);
    } else if (m.type === "progress") {
      setProgress(typeof m.p === "number" ? m.p : 0);
    } else if (m.type === "done" && m.dataUrl) {
      void shareWebm(m.dataUrl);
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
    : phase === "rendering" ? `Rendering… ${Math.round(progress * 100)}%`
    : phase === "saving" ? "Saving + sharing…"
    : phase === "done" ? "Shared ✓ — pick another ratio to make another"
    : phase === "unsupported" ? "This device's WebView can't record video"
    : phase === "error" ? `Failed: ${err}`
    : "";

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
              key={ratioKey}
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

        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
        <Text style={styles.status}>{label}</Text>
        {(phase === "rendering" || phase === "prep") && (
          <Text style={styles.hint}>Keep the app in the foreground while it renders — it's all on-device, no network.</Text>
        )}
      </View>
    </Modal>
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
  stage: { backgroundColor: "#000", alignSelf: "center" },
  bar: { height: 4, backgroundColor: theme.card, marginHorizontal: 16, marginTop: 18, borderRadius: 2, overflow: "hidden" },
  barFill: { height: 4, backgroundColor: theme.primary },
  status: { color: theme.text, fontSize: 15, fontWeight: "600", textAlign: "center", marginTop: 12 },
  hint: { color: theme.textTertiary, fontSize: 12, textAlign: "center", marginTop: 8, paddingHorizontal: 24, lineHeight: 18 },
});
