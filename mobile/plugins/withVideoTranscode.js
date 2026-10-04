// Wires the bespoke WebM→MP4 transcoder (native/videotranscode/, Media3 Transformer) into
// the generated android/ project: copies the Kotlin, registers the RN package (hand-written,
// not autolinkable) and adds the media3-transformer dependency. expo prebuild wipes android/,
// so this re-applies every build.
const { withDangerousMod, withMainApplication, withAppBuildGradle } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const PKG = "co.logos.perun.video.PerunVideoPackage";
const MEDIA3 = "1.9.0"; // same Media3 the Expo modules already pull in
const DEPS = [
  `implementation "androidx.media3:media3-transformer:${MEDIA3}"`,
  `implementation "androidx.media3:media3-effect:${MEDIA3}"`,
  `implementation "androidx.media3:media3-common:${MEDIA3}"`,
];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = function withVideoTranscode(config) {
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, "native/videotranscode/android/java");
      const dst = path.join(cfg.modRequest.platformProjectRoot, "app/src/main/java");
      if (fs.existsSync(src)) copyDir(src, dst);
      return cfg;
    },
  ]);

  config = withMainApplication(config, (cfg) => {
    if (!cfg.modResults.contents.includes(PKG)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /PackageList\(this\)\.packages\.apply\s*\{/,
        `PackageList(this).packages.apply {\n          // Replay video WebM -> MP4 (hardware H.264).\n          add(${PKG}())`
      );
    }
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    let g = cfg.modResults.contents;
    const missing = DEPS.filter((d) => !g.includes(d));
    if (missing.length) g = g.replace(/dependencies\s*\{/, `dependencies {\n    ${missing.join("\n    ")}`);
    cfg.modResults.contents = g;
    return cfg;
  });

  return config;
};
