// Config plugin: make react-native-background-actions' foreground service legal on
// Android 14 (targetSdk 34) for Perun's use — keeping the GPS run recorder alive while
// the app is backgrounded / screen-off. Perun accesses LOCATION in that service, so the
// type must be "location" (not "dataSync") and the app needs FOREGROUND_SERVICE_LOCATION.
// react-native-background-actions ships the <service> without a type, so we merge it in.
// POST_NOTIFICATIONS is for the ongoing "Recording your run" notification (Android 13+).
//
// NOTE: this is deliberately NOT the startLocationUpdatesAsync + expo-task-manager path
// that crashed on-device (v1.6/1.7). Here the existing FOREGROUND watchPositionAsync in
// recorder.ts keeps delivering fixes; this service only keeps the process resident.
const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

const SERVICE = "com.asterinet.react.bgactions.RNBackgroundActionsTask";

module.exports = function withForegroundService(config) {
  config = AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_LOCATION",
    "android.permission.POST_NOTIFICATIONS",
  ]);
  config = withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = app.service || [];
    let svc = app.service.find((s) => s.$ && s.$["android:name"] === SERVICE);
    if (!svc) {
      svc = { $: { "android:name": SERVICE } };
      app.service.push(svc);
    }
    svc.$["android:foregroundServiceType"] = "location";
    svc.$["android:exported"] = "false";
    return cfg;
  });
  return config;
};
