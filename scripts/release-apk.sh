#!/usr/bin/env bash
# Cut a GitHub release for the mobile app and attach the locally-built,
# locally-signed APK.
#
# WHY LOCAL, NOT CI: the release keystore (~/keystores/perun-release.jks) and its
# passwords (~/.gradle/gradle.properties) deliberately never leave this machine —
# an Android signing key can't be rotated, so leaking it means the app can never
# be updated again. CI has no key and MUST NOT sign. So the APK is built here and
# only the finished artifact is uploaded.
#
# Tag scheme: mobile-v<version> (the app and the module version independently;
# the module uses module-v* which triggers .github/workflows/release.yml).
set -euo pipefail

cd /home/vpavlin/perun
VERSION=$(python3 -c "import json;print(json.load(open('mobile/app.json'))['expo']['version'])")
TAG="mobile-v${VERSION}"
APK=dist/lan/perun-arm64.apk

# Refuse to release a tag that already exists — re-tagging a shipped version is
# the drift class we've been burned by all day.
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "release $TAG already exists — bump mobile/app.json version first" >&2
  exit 1
fi

# The APK must be the CURRENT version. build-apk.sh already hard-fails on a
# version mismatch, so a fresh build is the safe way to guarantee it.
echo "building signed APK for $VERSION …" >&2
bash scripts/build-apk.sh >/dev/null 2>&1 || { echo "APK build failed — run scripts/build-apk.sh to see why" >&2; exit 1; }

# Confirm the built APK actually carries this versionName before publishing it.
AAPT=$(ls -d /home/vpavlin/Android/Sdk/build-tools/*/aapt2 2>/dev/null | tail -1)
if [ -n "$AAPT" ]; then
  BUILT=$("$AAPT" dump badging "$APK" 2>/dev/null | grep -oP "versionName='\K[^']+")
  [ "$BUILT" = "$VERSION" ] || { echo "APK versionName $BUILT != $VERSION" >&2; exit 1; }
fi

SIZE=$(du -h "$APK" | cut -f1)
echo "publishing release $TAG (APK $SIZE) …" >&2
gh release create "$TAG" "$APK#Perun ${VERSION} (arm64 APK)" \
  --title "Perun mobile ${VERSION}" \
  --notes "Android app, arm64. Signed with the Perun release key.

Install via F-Droid (repo already configured) or download the APK directly.
sha256: $(sha256sum "$APK" | cut -d' ' -f1)"

echo "done: https://github.com/vpavlin/perun/releases/tag/${TAG}" >&2
