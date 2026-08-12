// Wires the bespoke type="location" foreground service (native/locationservice/) into
// the generated android/ project: copies the Kotlin, registers the RN package (hand-
// written, not autolinkable), and declares the <service> with foregroundServiceType
// "location". expo prebuild wipes android/, so this re-applies every build.
const { withDangerousMod, withMainApplication, withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const PKG = "co.logos.perun.loc.PerunLocationPackage";
const SERVICE = "co.logos.perun.loc.PerunLocationService";

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = function withLocationService(config) {
  // 1) copy the Kotlin into the generated project
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, "native/locationservice/android/java");
      const dst = path.join(cfg.modRequest.platformProjectRoot, "app/src/main/java");
      if (fs.existsSync(src)) copyDir(src, dst);
      return cfg;
    },
  ]);

  // 2) register the package (hand-written module — not autolinkable)
  config = withMainApplication(config, (cfg) => {
    if (!cfg.modResults.contents.includes(PKG)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /PackageList\(this\)\.packages\.apply\s*\{/,
        `PackageList(this).packages.apply {\n          // Bespoke location foreground service (background GPS recording).\n          add(${PKG}())`
      );
    }
    return cfg;
  });

  // 3) declare the <service> with type=location
  config = withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = app.service || [];
    if (!app.service.find((s) => s.$ && s.$["android:name"] === SERVICE)) {
      app.service.push({
        $: {
          "android:name": SERVICE,
          "android:foregroundServiceType": "location",
          "android:exported": "false",
        },
      });
    }
    return cfg;
  });

  return config;
};
