# Perun rebuild — research notes & source log

Running notes for the Perun → Logos (native mobile + Basecamp analytics) rebuild.
Companion to `~/perun-rebuild-plan.md`. **Keep this updated as facts are verified.**

**Today:** 2026-07-13. **Caution:** crib's logseq brain notes are Feb–Apr 2026 and may be stale — re-verify all Logos-side facts against live sources before relying on them.

---

## Freshness status of each research area

| Area | Source | Fetched | Confidence |
|---|---|---|---|
| **Perun current state** | live GitHub fetch (`vpavlin/perun`) | 2026-07-13 | HIGH — current |
| **Example Basecamp apps** (mesh-gateway, Stoa, forum-sample, fieldkit, logos-yolo) | live GitHub fetch | 2026-07-13 | HIGH — current |
| **Basecamp framework / tutorial / best practices** | live re-research | 2026-07-13 | HIGH — current |
| **Logos Delivery + Storage state** | live re-research | 2026-07-13 | HIGH — current |
| **Mobile binding status** (delivery/storage on iOS/Android) | live re-research + xAlisher repos | 2026-07-13 | HIGH — current |

---

## Verified-today facts (live fetch 2026-07-13)

### Perun (`github.com/vpavlin/perun`)
- Nov-2023 hackathon CRA/React 18 + TypeScript SPA. Live: perun.vercel.app.
- Records GPS via timer `getCurrentPosition` (no background). Data model bespoke JSON: `RunItem` + `StoreItem`/`GeoLocation` (no altitude/accuracy/HR). Metrics computed on read in `run.ts` (pure).
- Local: IndexedDB (`Store<T>`; `getAll` bug). Identity: ethers wallet, encrypted, pubkey=identity.
- **Already Waku-native:** `waku-dispatcher` on `/perun/0/sync/json`, asymmetric-encrypted to recipient pubkey; protocol `request_pairing`→`confirm_sync`→`sync_data({run,points})`; QR pairing. No server/Codex/IPFS.
- Proof-of-Run (iExec→NFT/CoreDAO): never worked; hardcoded insecure prover key in constants.ts.

### Example Basecamp apps (live fetch 2026-07-13)
- **forum-sample-app** (logos-co) = canonical template. Universal `ui_qml`: author only `.rep` contract + one backend (`SimpleSource` + `LogosUiPluginContext`); codegen does the rest. `metadata.json`: type/interface/category/main/view/dependencies/codegen.rep/nix. Pins `delivery_module` v0.1.3 (as of that fetch). Delivery recipe: createNode({mode:Core,preset:logos.test})→start→subscribe; raw-byte payloads; `.on()` before start; shared-singleton node; defer bootstrap off onContextReady; `logos.callModuleAsync`.
- **mesh gateway** (`vpavlin/basecamp-meshtastic`): core+ui modules; topic `deriveTopic→/meshtastic/1/<md5>/proto`; AES-256-GCM key = SHA256("mesh-gateway/lm-relay/v1\n"+psk); SQLite keyed by topic; full-state event payloads (signal-driven UI); self-hosted repo/`.lgx` distribution (logos-repo.json + index.json schemaVersion 1). Dual-manifest trick (metadata.embedded.json) for dep auto-load.
- **Stoa** (`vpavlin/stoa`): blockchain-inscription app (not Waku); reader+writer core modules + `ui_qml` viewer that ALSO builds a standalone + **Android APK** (Qt-on-Android path exists). AES-256-GCM delayed key reveal. Depends on `liblogos_zone_sequencer_module`.
- **logos-fieldkit** (`vpavlin/logos-fieldkit`): RPi offline node hosting Basecamp modules; local mirror of official module repo (`modules/index.json`) — reference for offline distribution.
- **logos-yolo** / **logos-yolo-board-module**: combines all three primitives (blockchain + delivery + storage/Codex attachments) — reference if we need Storage attachments.

**Conventions (from example apps):** universal `ui_qml`; per-module Nix flake → `.lgx` on `v*` tags; depend on `delivery_module`, LIP-23 topic `/app/1/name/proto`, raw-byte payloads, defer bootstrap, handle shared-singleton; signal-driven UI + `callModuleAsync`; persist keyed by stable id; AES-256-GCM from derived shared secret; surface appVersion from metadata; ship skills/helper-mds + dual license.

---

## From April brain notes — TO RE-VERIFY (may be stale)
- Basecamp module = desktop Qt/C++/QML `.lgx`; root QML Item not Window; logos-module-builder (Nix + module.yaml/metadata.json).
- Delivery mature on desktop (`delivery_module`); JS `@waku/sdk` in browser. **Mobile nim-ffi iOS/Android = post-v0.3; "no mobile support."** ← HIGHEST-PRIORITY re-check.
- Storage REST `POST /api/codex/v1/data`→CID, `GET …/data/{cid}/network/stream`; C API libstorage; `storage_module`. No mobile client.
- Waku payload/routing ≈150KB; Store/history was v0.2; segmentation v0.3.
- Inter-module IPC: `logos_core_call_plugin_method_async` (C API). Modules: kv_module, delivery_module/messaging_module, storage_module, chat_module, accounts_module, capability_module.
- KV: `kv_module` set/get/listAll; sync topic `/<app>/1/<id>/json`; AES-256-GCM per namespace (logos-kv-module v0.2).
- Reusable assets: **LMAO** (Rust Waku+Codex+SDS+CID offload, C-FFI), **Scala** (calendar UI module template), `logos-ui-module-scaffold` (backend module REQUIRED for UI to load), `logos-qt-mcp` (headless UI test).

---

## VERIFIED 2026-07-13 (live re-research) — deltas & mobile answer

**Alisher's RN delivery work (answers the user's question):**
- `xAlisher/receiver-android` — **React Native app, v1.0.1 (Jul 6 2026)**, MIT. Embeds **`liblogosdelivery`** (Logos Messaging Nim node) as `android/app/src/main/jniLibs/arm64-v8a/liblogosdelivery.so` via **JNI bridge** → runs a Logos Messaging node on-phone, cluster 2 relay, subscribes to a content topic. TS 40% / Kotlin 19% / C 35%. `kmp-tor` for .onion. **This is the proven mobile-Delivery path** (not a packaged npm module, but a reusable JNI-embed pattern/code).
- NOT the path: `logos-messaging/waku-react-native` is **archived (2023, go-waku)**; `@waku/sdk` in RN not production-ready (`@libp2p/tcp` broken RN≥0.77). Perun's browser js-waku does NOT port to RN.
- `liblogosdelivery` FFI lib introduced in delivery node v0.38.0 (Apr) / v0.38.1 (May 11) — the foundation Alisher builds on.
- xAlisher catalog (all current, July 2026): `keeper-basecamp` (preserve→Logos Storage + inscribe CIDs = Storage reference), `beacon-basecamp` (inscribe CIDs on-chain, QML), `booth-basecamp`/`receiver-basecamp` (radio over Logos Messaging), `logos-basecamp-modules` (catalog), `fdroid` (self-hosted F-Droid Android distribution), `qr-basecamp`.

**Basecamp standalone / Stoa-Android (user's 2nd question):**
- Standalone mode = single binary + own UI + only needed modules (vs discovery). Real. BUT Basecamp host is **Linux/macOS only**; **Android/iOS NOT shipped** (iOS "experimental" in spec Future Work; Android on blog roadmap). Stoa's Android APK = **Qt-for-Android** build of its QML viewer (mechanism undocumented; Logos data access on Android unconfirmed). Fallback for a *viewer*, not a capture app.

**Framework (verified):** authoring = `ui_qml`+`interface:universal`+`.rep`+backend still current; but "universal" now = **Qt-free `std` types + LIDL header→IDL codegen**; SDK split 3 repos (`logos-cpp-sdk`/`logos-protocol`/`logos-qt-sdk`). Canonical tutorial = **`logos-co/logos-tutorial` tutorial-v4 (Jun 28)**, runnable via `logos-doctest`. AI-authoring first-class (AGENTS/CLAUDE + skills + QML-inspector MCP on :3768). `.lgx` = gzip tar, **manifest schema 0.3.0**, Ed25519/`did:jwk` signing, package manager **`lgpm`**.

**Versions (2026-07-13):** basecamp host v0.2.1 (Jul 3) · delivery_module v0.1.3 (Jun 23) · storage_module v2.0.1 (Jul 1) · logos-storage-nim v0.4.1 (pre-alpha) · logos-delivery node v0.38.1 (May 11) · logos-module-builder v0.2.1 (Jul 3) · LGX schema 0.3.0.

**API corrections (were stale in April notes):**
- Storage REST base path **`/api/storage/v1/data`** (was `/api/codex/v1/data`), API v0.0.1. Endpoints: POST /data→CID, GET /data/{cid}, POST /data/{cid}/network, GET /data/{cid}/network/stream, .../manifest, GET /data (list), /data/{cid}/exists, /space.
- `delivery_module` v0.1.3 API: methods `createNode(cfgJSON)/start/stop/send(topic,payload)→reqId/subscribe/unsubscribe/getNodeInfo/getAvailableConfigs/collectOpenMetricsText`; events `messageSent/messageError/messagePropagated/messageReceived(hash,topic,base64,ns)/connectionStateChanged`. **Payloads base64 over FFI BOTH ways.** createNode cfg keys: mode/preset/relay/rlnRelay (no documented light-client switch).
- `storage_module` v2.0.1: lifecycle init/start/stop/destroy; upload uploadUrl/uploadInit/Chunk/Finalize; download downloadToUrl/downloadChunks(base64)/downloadManifest(async); exists/fetch/remove(async)/space/manifests/importFiles; **togglePrivateQueries(bool)** (Mix). Events storageUpload*/storageDownload*(base64 chunk)/storageRemoveDone.
- Waku per-message cap **still 150KB** → track blobs MUST go to Storage. Store/history REST available (page 20, max 100).

**Infra reality:** Storage **public testnet PAUSED since Aug 2025**, marketplace/incentives deprecated → **run your own delivery + storage node/gateway** (crib/pi5). Best-effort persistence only.

**Uncertain / open:** delivery light-client mode (undocumented); exact Stoa-Android build mechanism + its Logos data access; official module-repo index.json/logos-repo.json schema (not in current specs); iOS `liblogosdelivery` build (experimental).

## Open decisions (see plan §11)
1. Mobile stack: Expo/RN vs Rust-core-UniFFI(reuse LMAO) vs Qt-on-Android. 2. Identity/keys. 3. Wire format (CBOR/protobuf; GPX/CBOR track). 4. Storage node the phone POSTs to. 5. Module backend split. 6. Live-follow scope. 7. Proof-of-Run keep/drop/redesign. 8. Repo/naming/monorepo.

## Build progress (module)

- **Env**: crib converted to **multi-user nix daemon** — vpavlin + jimmy both build, sharing the warm store. All Logos builds now run as vpavlin in `~/perun`.
- **Repo**: `vpavlin/perun` (public); legacy web app → `vpavlin/perun-legacy`.
- **module/perun_analytics** (Basecamp `ui_qml`, universal, design-system styled):
  - it1: scaffolded from tutorial `#ui-qml-backend`, builds green, renders headless ✓
  - it2: `delivery_module` wired → connects to **logos.dev**, publishes/receives `RUN`; **two-instance receipt proven** (same msg_hash A→B, B rendered the run) ✓
  - it3: **C++ track codec** (byte-identical to JS contract codec) + `run_analytics` (distance/pace/elev/HR/splits) → detail UI with per-km splits; verified headless (3.83 km / 19:59 / 5:13 / 4 splits) ✓
- **Interim wire detail**: runs currently sent as a JSON envelope `{v,type:"RUN",run,track:<base64 compact blob>}`. Production format is raw-binary `TRACK_CHUNK` + chunking (wire-contract §5) — deferred until mobile wiring.
- **Testing**: headless via Xvfb + `nix run .#` (software renderer); autopublish gated by `PERUN_TEST_AUTOPUBLISH`.

- it4: **SQLite persistence** (`run_store`, own DB at `AppDataLocation/perun/runs.db`, no kv_module dep) — verified across restart (instance B loads instance A's run) ✓

### Logos module gotchas (learned)
- **`emit` is a Qt macro** — never name a lambda/var `emit` in code a Qt TU includes (pure-std headers pass g++ standalone but break once Qt is in the mix).
- **Hand-written `logos_module()` must pass `FIND_PACKAGES`/`LINK_LIBRARIES`** for extra libs — `metadata.json` `nix.cmake` fields do NOT auto-wire into it. Missing link = headers compile but symbols stay undefined → "Failed to load UI plugin" at `dlopen`. (`metadata.json` `nix.packages` still needed so the lib is a buildInput.)
- `ui_qml` plugin has **no host persistence path / identity** (`logos_ui_plugin_context.h`): only `modules()` + `onContextReady()`. Use your own data dir.
- Headless test: `nix run .#` builds+runs; `nix eval .#apps…program --raw` returns a path but does NOT build it. Don't `export HOME` before nix commands (breaks eval cache); set it only for the app process.

### Module — remaining
- raw-binary `TRACK_CHUNK` + chunking (match frozen contract; currently base64-in-JSON)
- identity via `accounts_module` + real per-owner topic (currently fixed `/perun/1/demo/proto`)
- elevation profile chart, map view; `.lgx` packaging for real Basecamp install

## Changelog
- 2026-07-13: Initial notes. Perun + example-apps verified live. Re-research launched for Basecamp framework and Delivery/Storage.
- 2026-07-13 (discussion): Decisions locked — RN mobile; phone drops Storage entirely; Delivery push is canonical transport (compact CBOR/protobuf + delta-encode → ~55KB/hr, under 150KB, chunk long runs); HTTP-to-local+Delivery-discovery = optional phase-2 fast path; Storage = Basecamp-side backup only (best-effort); E2E per-run encryption over relay; mix deferred (not prod-ready, preset-level, low value for personal sync, revisit for social sharing); north star = maximize value in Basecamp module (analytics/backup/beacon/accounts/sharing), phone stays thin. See plan §0b.
- 2026-07-13 (later): Live re-research complete. Big delta — mobile Delivery UNBLOCKED via xAlisher/receiver-android (RN + embedded liblogosdelivery JNI). Storage path/versions corrected; public testnet paused (run own nodes); base64 payloads; SDK 3-repo split; tutorial-v4 canonical. Added §0 update block to plan.md; flipped freshness table to HIGH/current.
