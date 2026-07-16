#!/usr/bin/env bash
# Publish the current release APK to the self-hosted F-Droid repo and rebuild the
# signed index. Run after each APK build (dist/lan/perun-arm64.apk must be fresh).
# Clients on an older versionCode then see an update in their F-Droid app.
#
# The repo home (config.yml + signing keystore) lives OUTSIDE the served dir at
# /home/vpavlin/fdroid; only repo/ is symlinked into dist/lan/fdroid/repo.
set -euo pipefail
export ANDROID_HOME=/home/vpavlin/Android/Sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
BT=$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)
export PATH="$JAVA_HOME/bin:$BT:$ANDROID_HOME/platform-tools:$PATH"

APK=/home/vpavlin/perun/dist/lan/perun-arm64.apk
FDROID=/home/vpavlin/fdroid-venv/bin/fdroid
[ -f "$APK" ] || { echo "no APK at $APK"; exit 1; }

cd /home/vpavlin/fdroid
cp -f "$APK" repo/perun-arm64.apk
"$FDROID" update --pretty < /dev/null
echo "published $("$BT"aapt2 dump badging "$APK" 2>/dev/null | grep -oE "versionName='[^']+'") to the F-Droid repo"
