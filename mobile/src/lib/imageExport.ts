// Capture a run's summary card to a PNG and open the OS share sheet — a
// "share the picture, not the file" path alongside GPX export. We snapshot the
// on-screen view exactly as rendered, so it honours the Hide-map toggle (issue
// #2): drop the basemap first and the shared image shows only the route shape,
// times, splits and elevation — nothing about where you were.
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";

// Same filename-stem hygiene as gpxExport (kept local to avoid coupling).
function safeStem(name: string | undefined): string {
  const stem = (name ?? "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 80);
  return stem || "run";
}

/**
 * Snapshot the view behind `ref` to a PNG in the cache dir and open the share
 * sheet. `ref` must point at a real, laid-out view (wrap it in a
 * `collapsable={false}` View on Android so it isn't view-flattened away).
 * Throws on capture/share failure so the caller can surface an alert.
 */
export async function shareViewImage(ref: React.RefObject<unknown>, name?: string): Promise<void> {
  if (!ref?.current) throw new Error("Nothing to capture yet");
  let uri = await captureRef(ref as never, {
    format: "png",
    quality: 1,
    result: "tmpfile", // writes to the app cache dir — the dir expo-sharing serves
    fileName: safeStem(name),
  });
  // react-native-view-shot returns a bare path on some Android versions;
  // expo-sharing needs a scheme.
  if (uri && !uri.startsWith("file://") && !uri.startsWith("content://")) uri = "file://" + uri;

  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing is not available on this device");
  await Sharing.shareAsync(uri, {
    mimeType: "image/png",
    UTI: "public.png",
    dialogTitle: name ? `Share ${name}` : "Share run",
  });
}
