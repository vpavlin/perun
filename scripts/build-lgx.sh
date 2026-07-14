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
echo "updated: /home/vpavlin/perun/dist/perun_analytics.lgx"
ls -l /home/vpavlin/perun/dist/perun_analytics.lgx
sha256sum /home/vpavlin/perun/dist/perun_analytics.lgx
