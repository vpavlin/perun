# perun

Rebuild of Perun (privacy-first run tracker) on the Logos stack. The original React web app now lives at [`vpavlin/perun-legacy`](https://github.com/vpavlin/perun-legacy); this is the new native-mobile + Basecamp version.

- **`core/`** — `perun_core`, the Basecamp **core module**: receives runs over **Logos Delivery**, decodes the compact track, computes splits/elevation/pace/HR and persists them (SQLite). It also runs headless as an always-on hub.
- **`module/`** — `perun_analytics`, the Basecamp **view** (desktop analytics) over `perun_core`.
- **`mobile/`** — the Android app: records runs (GPS, also in the background), shows them, and sends a run to your Basecamp with **Sync to Basecamp**. Uses the phone's shared Loam node when installed, otherwise its own node.
- **`packages/contract/`** — the shared wire contract: topics, message envelope, and the **compact track codec** (dependency-free, re-implementable in Kotlin/C++). `npm --prefix packages/contract run bench` validates that normal runs fit in one 150 KB Delivery message.
- **`repo/`** — a Basecamp package repository (`logos-repo.json` + `index.json`) so the module can be installed from Basecamp.
- **`docs/`** — [`demo.md`](docs/demo.md) (5-minute demo script), [`plan.md`](docs/plan.md), [`wire-contract.md`](docs/wire-contract.md), [`research-notes.md`](docs/research-notes.md).

**Principle:** keep the phone thin, put the value in the Basecamp module. No blockchain in scope for now; Storage is optional backup, not on the sync hot path.

## Install
- **Android:** add the F-Droid repository from [apps.vpavlin.xyz](https://apps.vpavlin.xyz) and install **Perun** (and **Loam**, recommended). arm64 phones.
- **Desktop (Basecamp 0.3, Linux x64):** add this repository in Basecamp's package manager, then install **Perun Analytics** (it pulls in `perun_core`):

```
https://apps.vpavlin.xyz/logos-repo.json
```

(Or install a portable `.lgx` directly from a [Release](https://github.com/vpavlin/perun/releases) with `lgpm install <url> --to ./modules`.)

## Build & release
- Build a portable bundle locally: `nix build ./module#lgx-portable` (always the **portable** variant, not `.#lgx`).
- CI (`.github/workflows/release.yml`): pushing a tag `v*` builds `perun_analytics` portable `.lgx` (linux-amd64) and attaches it to a GitHub Release.
- After releasing, refresh the repo index: `scripts/gen-repo-index.sh vX.Y.Z` then commit `repo/index.json`.

Status: the Android app and the Basecamp core + view are released (see [apps.vpavlin.xyz](https://apps.vpavlin.xyz)); the desktop is Linux x64 only for now. See `docs/plan.md`.
