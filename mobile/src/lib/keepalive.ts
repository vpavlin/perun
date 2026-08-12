// Background recording keep-alive: an Android foreground service (ongoing notification)
// that keeps the app PROCESS — and thus the recorder's foreground GPS watch
// (recorder.ts watchPositionAsync) — running while a run is recording, so the run keeps
// recording with the screen off / app backgrounded.
//
// Why this and not expo-location background updates: the startLocationUpdatesAsync +
// expo-task-manager + foreground-service path crashed on-device (v1.6/1.7). This instead
// uses react-native-background-actions to keep the JS thread resident; the existing
// FOREGROUND watchPositionAsync keeps delivering fixes because a type="location"
// foreground service keeps the app in the "in use" state (no ACCESS_BACKGROUND_LOCATION
// prompt needed — the service starts while the app is in the foreground). Best-effort:
// if the device denies the service we just fall back to the old screen-on behaviour.
import BackgroundService from "react-native-background-actions";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The resident task does nothing but stay alive — the recorder's own watch ingests fixes.
// It loops until the service is stopped.
const task = async () => {
  // eslint-disable-next-line no-constant-condition
  while (BackgroundService.isRunning()) {
    await sleep(60000);
  }
};

const OPTIONS = {
  taskName: "perunRecording",
  taskTitle: "Perun",
  taskDesc: "Recording your run",
  // ic_launcher exists as a mipmap after prebuild; avoids needing a bespoke drawable.
  taskIcon: { name: "ic_launcher", type: "mipmap" },
  color: "#0d1013",
  linkingURI: "perun://",
  // Perun uses location in the background → the service must be type "location".
  foregroundServiceType: ["location"],
};

// TEMPORARILY DISABLED — starting a type="location" foreground service NATIVELY
// crashes on run start (Android 16 / targetSdk 36; the crash bypasses the try/catch
// below because it's thrown in native startForeground, not JS). The 4.0.1 downgrade
// (matching qaku, which uses a dataSync FGS) did NOT fix it, so it's the LOCATION FGS
// type on Android 16, not the library version. Until that's solved, record
// FOREGROUND-ONLY (watchPositionAsync keeps delivering while the app is visible) so a
// run at least starts. Re-enable by flipping this flag once the location FGS is fixed
// (candidate: a bespoke Kotlin location FGS, or dataSync with the background-location
// trade-off).
const FGS_ENABLED = false;

/** Start the recording foreground service (best-effort; no throw). */
export async function startRunService(): Promise<void> {
  if (!FGS_ENABLED) return; // foreground-only recording — see note above
  try {
    if (!BackgroundService.isRunning()) {
      await BackgroundService.start(task, OPTIONS as Parameters<typeof BackgroundService.start>[1]);
    }
  } catch (e) {
    console.log("[perun] foreground service start failed:", e);
  }
}

/** Stop the recording foreground service (best-effort; no throw). */
export async function stopRunService(): Promise<void> {
  try {
    if (BackgroundService.isRunning()) await BackgroundService.stop();
  } catch {
    /* ignore */
  }
}
