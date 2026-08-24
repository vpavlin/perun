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

/** Read a locally-held photo blob and return a data: URI, or null if we don't have it. */
async function photoDataUri(a: Annotation): Promise<string | null> {
  if (a.kind !== "photo" || !a.blobId) return null;
  const uri = localBlobUri(a.blobId, a.mime || "image/jpeg");
  if (!uri) return null; // only embed what's on THIS device (offline)
  try {
    const bytes = await readFileBytes(uri);
    return `data:${a.mime || "image/jpeg"};base64,${fromByteArray(bytes)}`;
  } catch {
    return null;
  }
}

/** Build the JSON the WebView renderer consumes. */
async function buildPayload(run: Run, annotations: Annotation[]) {
  const points = run.track.points.map((p) => ({ lat: p.lat, lon: p.lon, alt: p.alt ?? 0, t: p.t }));
  let photos = 0;
  const anns = [];
  for (const a of annotations) {
    if (a.kind !== "text" && a.kind !== "photo" && a.kind !== "voice") continue;
    let img: string | null = null;
    if (a.kind === "photo" && photos < MAX_PHOTOS) {
      img = await photoDataUri(a);
      if (img) photos++;
    }
    anns.push({ t: a.t, kind: a.kind, text: a.text || "", img: img || undefined });
  }
  return {
    name: run.name,
    points,
    annotations: anns,
    opts: { durationS: 12, size: 900, bitrate: 4_000_000 },
  };
}

export function ReplayVideo({ run, visible, onClose }: { run: Run; visible: boolean; onClose: () => void }) {
  const annotations = useAnnotations(run.id);
  const webRef = useRef<WebView>(null);
  const payloadRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>("prep");
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string>("");

  // Assemble the payload whenever the sheet opens (fresh, in case annotations changed).
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setPhase("prep"); setProgress(0); setErr("");
    buildPayload(run, annotations).then((p) => {
      if (alive) payloadRef.current = JSON.stringify(p);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, run.id]);

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

  const W = Dimensions.get("window").width;
  const label =
    phase === "prep" ? "Preparing…"
    : phase === "rendering" ? `Rendering… ${Math.round(progress * 100)}%`
    : phase === "saving" ? "Saving + sharing…"
    : phase === "done" ? "Shared ✓"
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

        {/* The WebView renders the animation live (visible so requestAnimationFrame isn't
            throttled) and records it. It's the preview + the encoder in one. */}
        <View style={[styles.stage, { width: W, height: W }]}>
          {visible && (
            <WebView
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
  stage: { backgroundColor: "#000", alignSelf: "center" },
  bar: { height: 4, backgroundColor: theme.card, marginHorizontal: 16, marginTop: 18, borderRadius: 2, overflow: "hidden" },
  barFill: { height: 4, backgroundColor: theme.primary },
  status: { color: theme.text, fontSize: 15, fontWeight: "600", textAlign: "center", marginTop: 12 },
  hint: { color: theme.textTertiary, fontSize: 12, textAlign: "center", marginTop: 8, paddingHorizontal: 24, lineHeight: 18 },
});
