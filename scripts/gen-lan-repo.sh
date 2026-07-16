#!/usr/bin/env bash
# Generate a Logos Basecamp package repository on this LAN box, so Basecamp
# installs Perun over local WiFi instead of GitHub.
#
# Add this URL in Basecamp → Settings → Package Repositories:
#     https://<host>:8443/logos-repo.json
#
# TWO THINGS THAT ARE EASY TO GET WRONG (both cost us a round trip):
#
# 1. The repo URL must be **https**. logos-package-downloader has a hardcoded
#    prefix check with no bypass:
#        bool isHttpsUrl(const url) { return url.rfind("https://", 0) == 0; }
#        if (!isHttpsUrl(url)) return "unsupported URL scheme (https required in v1)";
#    "v1" there is the repository-REGISTRY feature version, NOT index.json's
#    schemaVersion — bumping schemaVersion does nothing. Hence gen-lan-certs.sh.
#
# 2. The repo URL points at **logos-repo.json** (the catalog "identity card"),
#    NOT index.json. logos-repo.json carries indexUrl → index.json. Handing
#    Basecamp an index.json directly fails with "logos-repo.json: <parse error>".
#
# Schema: logos-co/logos-modules-release-tool/docs/catalog-format.md
#   - logos-repo.json: schemaVersion 1; requires name, displayName, indexUrl
#   - index.json:      schemaVersion 2 (matches the official repo's index)
set -euo pipefail

LAN_DIR=/home/vpavlin/perun/dist/lan
PORT="${PORT:-8443}"
HOST="${1:-$(hostname -I | awk '{print $1}')}"
BASE="https://${HOST}:${PORT}"

cd "$LAN_DIR"

python3 - "$BASE" <<'PY' > index.json
import glob, hashlib, json, subprocess, sys, datetime

base = sys.argv[1]
packages = []

for lgx in sorted(glob.glob("*.lgx")):
    try:
        manifest = json.loads(subprocess.check_output(["tar", "xzOf", lgx, "manifest.json"]))
    except Exception as e:
        print(f"skip {lgx}: {e}", file=sys.stderr)
        continue
    data = open(lgx, "rb").read()
    name = manifest["name"]
    ver = manifest.get("version", "0.0.0")
    packages.append({
        "name": name,
        "versions": [{
            "releasedAt": datetime.datetime.now(datetime.timezone.utc)
                            .strftime("%Y-%m-%dT%H:%M:%SZ"),
            "publisherRef": f"{name}-v{ver}",
            # Absolute URL on THIS host: Basecamp fetches the .lgx from here.
            "url": f"{base}/{lgx}",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "rootHash": manifest["hashes"]["root"],
            "manifest": manifest,
        }],
    })

json.dump({
    "schemaVersion": 2,
    "repositoryName": "perun-lan",
    "generatedAt": datetime.datetime.now(datetime.timezone.utc)
                     .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "packages": packages,
}, sys.stdout, indent=2)
print()

for p in packages:
    v = p["versions"][0]
    print(f"  + {p['name']:20} {v['size']/1048576:5.1f} MB  {v['url']}", file=sys.stderr)
PY

# The identity card. trustedSigners is empty: we don't sign our .lgx, and an
# empty list means the catalog vouches for no signer — installability of an
# unsigned package is then the package-manager's signature-policy decision.
python3 - "$BASE" <<'PY' > logos-repo.json
import json, sys
base = sys.argv[1]
json.dump({
    "schemaVersion": 1,
    "name": "perun-lan",
    "displayName": "Perun (LAN)",
    "description": "Perun analytics + QR modules served from the local network.",
    "indexUrl": f"{base}/index.json",
    "trustedSigners": [],
}, sys.stdout, indent=2)
print()
PY

echo "" >&2
echo "Add this in Basecamp → Settings → Package Repositories:" >&2
echo "    ${BASE}/logos-repo.json" >&2
