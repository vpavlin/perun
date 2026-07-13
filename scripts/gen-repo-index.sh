#!/usr/bin/env bash
# Regenerate repo/index.json from the portable LGX for a given tag.
# Run after building/releasing a new version:  scripts/gen-repo-index.sh v0.1.0
set -euo pipefail
TAG="${1:?usage: gen-repo-index.sh <vX.Y.Z>}"
cd "$(dirname "$0")/.."

echo "building ./module#lgx-portable …" >&2
nix build ./module#lgx-portable -o /tmp/perun-lgx-out >/dev/null
LGX=$(echo /tmp/perun-lgx-out/*.lgx)

SIZE=$(stat -c%s "$LGX")
SHA=$(sha256sum "$LGX" | cut -d' ' -f1)
MANIFEST=$(tar xzOf "$LGX" manifest.json)

TAG="$TAG" SIZE="$SIZE" SHA="$SHA" MANIFEST="$MANIFEST" python3 - > repo/index.json <<'PY'
import os, json
m = json.loads(os.environ["MANIFEST"])
tag, name = os.environ["TAG"], m["name"]
idx = {
    "schemaVersion": 1,
    "repositoryName": "perun",
    "generatedAt": tag,
    "packages": [{
        "name": name,
        "versions": [{
            "releasedAt": tag,
            "publisherRef": f"{name}-{tag}",
            "url": f"https://github.com/vpavlin/perun/releases/download/{tag}/logos-{name}-module-linux-amd64.lgx",
            "size": int(os.environ["SIZE"]),
            "sha256": os.environ["SHA"],
            "rootHash": m["hashes"]["root"],
            "manifest": m,
        }],
    }],
}
print(json.dumps(idx, indent=2))
PY
echo "wrote repo/index.json for $(echo "$MANIFEST" | python3 -c 'import sys,json;print(json.load(sys.stdin)["name"], json.load(sys.stdin)["version"] if False else "")')$TAG" >&2
