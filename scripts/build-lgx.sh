#!/usr/bin/env bash
# Build the portable perun_core + perun_analytics LGX bundles (ADR 0006: the desktop
# side is now a headless CORE + a thin VIEW). The view builds against the local core
# via --override-input, so build the core FIRST.
#   perun/dist/perun_core.lgx       <- headless engine/sync/hub
#   perun/dist/perun_analytics.lgx  <- the ui_qml view over it
# Run after every fix/feature. Publishes to the LAN repo too (:8443) via gen-lan-repo.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source /etc/profile.d/nix-daemon.sh 2>/dev/null || true
mkdir -p "$ROOT/dist"

echo "== building perun_core (headless) =="
( cd "$ROOT/core" && nix build .#lgx-portable -o /tmp/perun-core-out --print-out-paths >/dev/null )
install -m644 /tmp/perun-core-out/*.lgx "$ROOT/dist/perun_core.lgx"

echo "== building perun_analytics (view; override core -> ../core) =="
( cd "$ROOT/module" && nix build .#lgx-portable -o /tmp/perun-view-out \
    --override-input perun_core "path:$ROOT/core" --print-out-paths >/dev/null )
install -m644 /tmp/perun-view-out/*.lgx "$ROOT/dist/perun_analytics.lgx"

# Publish both to the LAN server (:8443). gen-lan-repo.sh scans dist/lan and rebuilds
# the signed index (size+sha256 must match the .lgx or Basecamp refuses to install).
if [ -d "$ROOT/dist/lan" ]; then
  install -m644 "$ROOT/dist/perun_core.lgx"      "$ROOT/dist/lan/perun_core.lgx"
  install -m644 "$ROOT/dist/perun_analytics.lgx" "$ROOT/dist/lan/perun_analytics.lgx"
  bash "$ROOT/scripts/gen-lan-repo.sh"
fi

echo "updated:"
for f in perun_core perun_analytics; do
  ls -l "$ROOT/dist/$f.lgx"; sha256sum "$ROOT/dist/$f.lgx"
done
