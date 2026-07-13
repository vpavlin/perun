# perun

Rebuild of Perun (privacy-first run tracker) on the Logos stack. The original React web app now lives at [`vpavlin/perun-legacy`](https://github.com/vpavlin/perun-legacy); this is the new native-mobile + Basecamp version.

- **`module/`** — Logos **Basecamp** `ui_qml` module (desktop): detailed analytics — receives runs over **Logos Delivery**, decodes the compact track, computes splits/elevation/pace/HR, persists to a local SQLite DB. **Working today.**
- **`mobile/`** — React Native capture app (record runs + basic view). Pushes runs over Logos Delivery (embeds `liblogosdelivery` via JNI, à la `xAlisher/receiver-android`). **Not built yet.**
- **`packages/contract/`** — the shared wire contract: topics, message envelope, and the **compact track codec** (dependency-free, re-implementable in Kotlin/C++). `npm --prefix packages/contract run bench` validates that normal runs fit in one 150 KB Delivery message.
- **`repo/`** — a Basecamp package repository (`logos-repo.json` + `index.json`) so the module can be installed from Basecamp.
- **`docs/`** — [`plan.md`](docs/plan.md), [`wire-contract.md`](docs/wire-contract.md), [`research-notes.md`](docs/research-notes.md).

**Principle:** keep the phone thin, put the value in the Basecamp module. No blockchain in scope for now; Storage is optional backup, not on the sync hot path.

## Install in Basecamp
Add this repository in Basecamp's package manager, then install **Perun Analytics**:

```
https://raw.githubusercontent.com/vpavlin/perun/master/repo/logos-repo.json
```

(Or install a portable `.lgx` directly from a [Release](https://github.com/vpavlin/perun/releases) with `lgpm install <url> --to ./modules`.)

## Build & release
- Build a portable bundle locally: `nix build ./module#lgx-portable` (always the **portable** variant, not `.#lgx`).
- CI (`.github/workflows/release.yml`): pushing a tag `v*` builds `perun_analytics` portable `.lgx` (linux-amd64) and attaches it to a GitHub Release.
- After releasing, refresh the repo index: `scripts/gen-repo-index.sh vX.Y.Z` then commit `repo/index.json`.

Status: Basecamp analytics module is a working MVP (Delivery sync + analytics + SQLite persistence, verified on the logos.dev fleet). Mobile app is next. See `docs/plan.md`.
