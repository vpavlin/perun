#!/usr/bin/env bash
# Build the arm64 release APK, drop it at dist/lan/perun-arm64.apk, and publish
# it to the self-hosted F-Droid repo. Version comes from app.json (expo.version +
# android.versionCode) — bump those, not build.gradle (prebuild regenerates it).
set -uo pipefail
export ANDROID_HOME=/home/vpavlin/Android/Sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# Regenerate the native project from app.json. This is NOT optional: android/ is
# generated (untracked) and holds its own copy of versionCode/versionName, so
# without this a version bump in app.json is silently ignored and you ship the
# previous version under a new name. It also re-applies the config plugins
# (withLogosDelivery, withReleaseSigning).
cd /home/vpavlin/perun/mobile || exit 3
echo "=== prebuild start $(date '+%H:%M:%S') ==="
npx expo prebuild --platform android || exit 3

cd /home/vpavlin/perun/mobile/android || exit 3
# Fail loudly if the bump still didn't land, rather than publishing a stale build.
want_vc=$(python3 -c "import json;print(json.load(open('../app.json'))['expo']['android']['versionCode'])")
got_vc=$(grep -oP 'versionCode\s+\K\d+' app/build.gradle | head -1)
[ "$want_vc" = "$got_vc" ] || { echo "VERSION MISMATCH: app.json=$want_vc build.gradle=$got_vc"; exit 4; }

echo "=== assembleRelease start $(date '+%H:%M:%S') ==="
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain
rc=$?
echo "=== assembleRelease rc=$rc $(date '+%H:%M:%S') ==="
[ $rc -eq 0 ] || { echo "BUILD_APK_DONE"; exit $rc; }

cp /home/vpavlin/perun/mobile/android/app/build/outputs/apk/release/app-release.apk \
   /home/vpavlin/perun/dist/lan/perun-arm64.apk
ls -l /home/vpavlin/perun/dist/lan/perun-arm64.apk
echo "APK_COPIED"

# Publish to the F-Droid repo so clients see it as an update.
bash /home/vpavlin/perun/scripts/fdroid-publish.sh && echo "FDROID_PUBLISHED"
echo "BUILD_APK_DONE"
