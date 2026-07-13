# perun

Rebuild of Perun (privacy-first run tracker) on the Logos stack. The original React web app now lives at [`vpavlin/perun-legacy`](https://github.com/vpavlin/perun-legacy); this is the new native-mobile + Basecamp version.

- **`mobile/`** — React Native capture app (record runs + basic view). Pushes runs over **Logos Delivery** (embeds `liblogosdelivery` via JNI, à la `xAlisher/receiver-android`).
- **`module/`** — Logos **Basecamp** `ui_qml` module (desktop): detailed analytics, optional best-effort **Logos Storage** backup.
- **`packages/contract/`** — the shared wire contract: topics, message envelope, and the **compact track codec** (dependency-free, re-implementable in Kotlin/C++). `npm --prefix packages/contract run bench` validates that normal runs fit in one 150 KB Delivery message.
- **`docs/`** — [`plan.md`](docs/plan.md) (build plan), [`wire-contract.md`](docs/wire-contract.md) (frozen v1 contract), [`research-notes.md`](docs/research-notes.md) (dated source log).

**Principle:** keep the phone thin, put the value in the Basecamp module. No blockchain in scope for now; Storage is optional backup, not on the sync hot path.

Status: Phase 0 (contract frozen + codec benchmarked). See `docs/plan.md` §9 for the roadmap.
