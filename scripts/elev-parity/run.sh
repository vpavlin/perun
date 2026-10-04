#!/usr/bin/env bash
# Elevation analytics parity: the phone (mobile/src/lib/analytics.ts) and the desktop core
# (core/src/run_analytics.h) must give identical gain + splits on the same track. Builds a
# deterministic jumpy track (jitter, a real drop, a stale-source flip, a pause, missing altitudes),
# runs both, and compares.   Usage: scripts/elev-parity/run.sh
set -euo pipefail
cd "$(dirname "$0")"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
node -e "
const ts=require('../../mobile/node_modules/typescript'); const fs=require('fs');
const src=fs.readFileSync('../../mobile/src/lib/analytics.ts','utf8');
fs.writeFileSync('$T/analytics.mjs', ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText.replace(/from \"\.\/types\";?/,'from \"data:text/javascript,\";'));"
sed -e "s#/tmp/claude-1000/analytics.mjs#$T/analytics.mjs#; s#/tmp/claude-1000/track.json#$T/track.json#" gen.mjs > "$T/gen.mjs"
sed -e "s#/tmp/claude-1000/track.json#$T/track.json#" parity.cpp > "$T/parity.cpp"
TS=$(node "$T/gen.mjs" | sed 's/^TS  //'); g++ -std=c++17 -include cstring -I ../../core/src "$T/parity.cpp" -o "$T/parity"
CPP=$("$T/parity" | sed 's/^C++ //'); echo "TS : $TS"; echo "C++: $CPP"
[ "$TS" = "$CPP" ] && echo "ELEVATION PARITY OK" || { echo "ELEVATION PARITY MISMATCH"; exit 1; }
