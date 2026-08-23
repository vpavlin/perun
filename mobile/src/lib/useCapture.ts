// Shared annotation-capture hook — the ONE place that turns a tap into a stored
// annotation, used by both the live recording bar (QuickAnnotate) and the saved-run
// composer (RunAnnotations). Everything here is LOCAL-FIRST: text is metadata-only;
// a photo/voice is written to the on-device blob store (blob.saveLocalBlob) and the
// annotation is authored immediately, THEN a sealed copy is pushed to the server in
// the background (replicateBlob) — capture never waits on, or fails without, a server.
import { useRef, useState } from "react";
import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  useAudioRecorder, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync,
} from "expo-audio";
import { GeoPoint } from "./types";
import { authorAnnotation } from "./annotations";
import { readFileBytes, saveLocalBlob, replicateBlob } from "./blob";

export interface Capture {
  /** Non-null while a capture is in flight — a short status string to show. */
  busy: string | null;
  /** True while the voice recorder is running (drives the recording overlay). */
  recording: boolean;
  /** Save a text note pinned to `point`. Returns true if it was saved. */
  addText: (text: string, point: GeoPoint) => Promise<boolean>;
  /** Capture a photo (camera or library) pinned to `point`. */
  addPhoto: (fromCamera: boolean, point: GeoPoint, caption?: string) => Promise<void>;
  /** Begin recording a voice note (pin is chosen when you stop). */
  startVoice: () => Promise<boolean>;
  /** Stop + save the voice note pinned to `point`. */
  stopVoice: (point: GeoPoint, caption?: string) => Promise<void>;
  /** Discard an in-progress recording. */
  cancelVoice: () => Promise<void>;
}

export function useCapture(runId: string): Capture {
  const [busy, setBusy] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recStartRef = useRef(0);

  const addText = async (text: string, point: GeoPoint): Promise<boolean> => {
    const body = text.trim();
    if (!body) return false;
    setBusy("Saving note…");
    try {
      await authorAnnotation({ runId, point, kind: "text", text: body });
      return true;
    } catch (e) {
      Alert.alert("Couldn't save note", e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const addPhoto = async (fromCamera: boolean, point: GeoPoint, caption?: string): Promise<void> => {
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
      setBusy("Saving photo…");
      const bytes = await readFileBytes(asset.uri);
      const blobId = await saveLocalBlob(bytes, mime); // on-device, no server needed
      await authorAnnotation({
        runId, point, kind: "photo", blobId, mime, text: caption?.trim() || undefined,
      });
      void replicateBlob(blobId, mime); // best-effort background push to the server
    } catch (e) {
      Alert.alert("Photo failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const startVoice = async (): Promise<boolean> => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Microphone off", "Enable microphone access to record a voice note.");
        return false;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recStartRef.current = Date.now();
      setRecording(true);
      return true;
    } catch (e) {
      Alert.alert("Can't record", e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const stopVoice = async (point: GeoPoint, caption?: string): Promise<void> => {
    setRecording(false);
    setBusy("Saving voice note…");
    try {
      await recorder.stop();
      const uri = recorder.uri;
      const dur = Math.max(1, Math.round((Date.now() - recStartRef.current) / 1000));
      if (!uri) throw new Error("No recording produced");
      const mime = "audio/m4a";
      const bytes = await readFileBytes(uri);
      const blobId = await saveLocalBlob(bytes, mime); // on-device, no server needed
      await authorAnnotation({
        runId, point, kind: "voice", blobId, mime, dur, text: caption?.trim() || undefined,
      });
      void replicateBlob(blobId, mime); // best-effort background push to the server
    } catch (e) {
      Alert.alert("Voice failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const cancelVoice = async (): Promise<void> => {
    setRecording(false);
    try {
      await recorder.stop();
    } catch {
      /* ignore */
    }
  };

  return { busy, recording, addText, addPhoto, startVoice, stopVoice, cancelVoice };
}
