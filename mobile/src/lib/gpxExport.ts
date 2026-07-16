// Export a Run as a standard .gpx file and open the OS share sheet.
//
// Expo SDK 57 (RN 0.86): expo-file-system uses the class-based API
// (File / Paths). We write the GPX text to the app cache directory,
// then hand the file:// URI to expo-sharing so the user can send it
// to Strava / Garmin Connect / Files / email, etc.
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { toGpx } from "./gpx";
import { Run } from "./types";

const GPX_MIME = "application/gpx+xml";
// Apple UTI for GPX. Not universally registered, so we fall back to a
// generic XML UTI which every target on iOS understands.
const GPX_UTI = "com.topografix.gpx";

// Turn an arbitrary run name into a safe, non-empty filename stem.
function safeStem(name: string | undefined): string {
  const stem = (name ?? "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_") // anything not word/dot/dash -> underscore
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "") // trim leading/trailing separators
    .slice(0, 80);
  return stem || "run";
}

/**
 * Build the GPX for `run`, write it to a temp cache file named after the
 * run, and open the share sheet. Resolves once the sheet has been handled.
 *
 * Safe to call on an empty track (toGpx still yields a valid, empty <trk>).
 * Throws only on genuine I/O failures so the caller can surface an error.
 */
export async function exportRun(run: Run): Promise<void> {
  const xml = toGpx(run.track);
  const filename = `${safeStem(run?.name)}.gpx`;

  // Write to the cache directory (transient, OS-reclaimable storage).
  const file = new File(Paths.cache, filename);
  try {
    // Overwrite any stale export from a previous share of the same run.
    if (file.exists) file.delete();
  } catch {
    // Non-fatal: fall through and let write() report a real problem.
  }
  file.create({ overwrite: true, intermediates: true });
  file.write(xml);

  // Sharing may be unavailable (e.g. some simulators / restricted devices).
  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    throw new Error(
      `Sharing is not available on this device. GPX saved to: ${file.uri}`,
    );
  }

  await Sharing.shareAsync(file.uri, {
    mimeType: GPX_MIME,
    UTI: GPX_UTI,
    dialogTitle: `Export ${run?.name ?? "run"} (GPX)`,
  });
}
