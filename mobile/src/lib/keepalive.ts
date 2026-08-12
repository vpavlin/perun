// Background recording keep-alive: a type="location" Android foreground service that
// keeps the app in the "in use" state so the recorder's FOREGROUND watch
// (recorder.ts watchPositionAsync) keeps delivering fixes with the screen off / phone
// in a pocket — no ACCESS_BACKGROUND_LOCATION prompt needed.
//
// Why a BESPOKE native service (native/locationservice/, wired by plugins/withLocationService.js):
// react-native-background-actions' location-type startForeground NATIVE-crashes on
// Android 16 (API 36) — the crash is thrown in native code, bypassing any JS try/catch,
// which is why the 4.0.1 downgrade didn't help (it's the location FGS type, not the lib
// version; Logos Delivery / qaku are fine because they use the dataSync type). Our
// PerunLocationService calls startForeground(id, notification, FOREGROUND_SERVICE_TYPE_LOCATION)
// the modern way and is best-effort (it stopSelf()s rather than crashing on failure).
import { NativeModules } from "react-native";

const PerunLocation = (NativeModules as any).PerunLocation as
  | { start: () => Promise<boolean>; stop: () => Promise<boolean>; update: (text: string) => Promise<boolean> }
  | undefined;

/** Update the ongoing recording notification with live run stats (silent). */
export async function updateRunNotification(text: string): Promise<void> {
  try {
    await PerunLocation?.update?.(text);
  } catch {
    /* service not up / update failed — harmless */
  }
}

/** Start the recording foreground service (best-effort; never throws to the caller). */
export async function startRunService(): Promise<void> {
  try {
    await PerunLocation?.start?.();
  } catch (e) {
    // A denied/failed FGS just means foreground-only recording — the run still records
    // while the app is visible; don't break run start.
    console.log("[perun] location foreground service start failed:", e);
  }
}

/** Stop the recording foreground service (best-effort; never throws). */
export async function stopRunService(): Promise<void> {
  try {
    await PerunLocation?.stop?.();
  } catch {
    /* ignore */
  }
}
