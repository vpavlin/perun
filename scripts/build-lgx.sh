#!/usr/bin/env bash
# Build the portable perun_analytics LGX and refresh the stable path that the
# laptop scp's:  /home/vpavlin/perun/dist/perun_analytics.lgx
# Run after every fix/feature.
set -euo pipefail
cd "$(dirname "$0")/../module"
source /etc/profile.d/nix-daemon.sh 2>/dev/null || true
nix build .#lgx-portable -o /tmp/perun-lgx-out --print-out-paths >/dev/null
mkdir -p /home/vpavlin/perun/dist
install -m644 /tmp/perun-lgx-out/*.lgx /home/vpavlin/perun/dist/perun_analytics.lgx
# Publish to the LAN server too. This used to be a manual copy, which silently
# drifted: dist/ had the new build while the laptop kept downloading yesterday's.
if [ -d /home/vpavlin/perun/dist/lan ]; then
  install -m644 /home/vpavlin/perun/dist/perun_analytics.lgx \
    /home/vpavlin/perun/dist/lan/perun_analytics.lgx
  # Regenerate the repo index in the same breath. The index carries the .lgx's
  # size + sha256, so a new build with a stale index means Basecamp downloads
  # bytes that don't match the hash and refuses to install — silently blaming
  # the file rather than the index.
  bash /home/vpavlin/perun/scripts/gen-lan-repo.sh
fi
echo "updated: /home/vpavlin/perun/dist/perun_analytics.lgx"
ls -l /home/vpavlin/perun/dist/perun_analytics.lgx
sha256sum /home/vpavlin/perun/dist/perun_analytics.lgx
