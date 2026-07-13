# Perun on Logos — build plan (finalized v2)

**Date:** 2026-07-13 · **Status:** finalized, iterating · No blockchain in scope for now.

Rebuild `github.com/vpavlin/perun` (a privacy-first run tracker) as two halves that sync over **Logos Delivery** (Waku):

- **(A) Perun Mobile** — a **React Native** app: record runs (background GPS) + basic viewing.
- **(B) Perun Analytics** — a **Logos Basecamp module** (desktop, `ui_qml`): detailed analytics, and (optional, best-effort) **Logos Storage** backup.

Guiding principle: **keep the phone thin, put the value in the Basecamp module.**

---

## 1. Decisions (locked 2026-07-13)

1. **Mobile = React Native**, embedding **`liblogosdelivery`** via a JNI bridge (the `xAlisher/receiver-android` pattern — a proven RN app that runs a Logos Messaging node on-device). Android-first; iOS later (its `liblogosdelivery` build is still experimental). Reuse Perun's TS domain logic (metrics) on the JS side.
2. **Phone never touches Logos Storage** — no CID/storage client on mobile. It only captures + pushes.
3. **Transport = Delivery push (canonical).** Runs are sent over Delivery in a **compact binary format** (delta-encoded), which keeps a normal run under Waku's **150 KB/message** cap; long runs are **chunked**.
4. **Optional phase-2 fast path:** same-LAN **HTTP upload to the local Basecamp module** + **Delivery for discovery** (module announces its address). Not built first.
5. **Storage = Basecamp-side backup only** — best-effort today (public testnet paused), improves later. The module owns it; the phone doesn't.
6. **End-to-end per-run encryption** (symmetric run key derived from a shared secret; sender signs). Content is private over plain relay, independent of routing.
7. **Mix (libp2p) deferred** — not production-ready and looks preset-level, not per-message, in `delivery_module` v0.1.3. Low value for personal phone→own-Basecamp sync; revisit for **social/shared** runs. Keep the message layer mix-agnostic.
8. **No blockchain for now** — drop on-chain beacon/inscription and the old iExec/NFT "Proof-of-Run." Can revisit as a verifiable-history feature later.

**Still open (provisional defaults in _italics_):** identity model (_align module to `accounts_module` + a paired phone key_); wire format (_CBOR-ish compact binary, see §4_); reuse Alisher's JNI bridge directly (_yes — adapt `receiver-android`, fall back to fresh build_); repo layout (_single monorepo `perun/`; original web app renamed to `perun-legacy`_).

---

## 2. Perun today (what carries over)

Nov-2023 CRA/React 18 + TypeScript SPA, hackathon-grade. **Already Waku-native** (`waku-dispatcher` on `/perun/0/sync/json`, asymmetric-encrypted to a recipient pubkey; `request_pairing`→`confirm_sync`→`sync_data({run,points})`; QR pairing). IndexedDB local store; ethers-wallet identity.

- **Reuse:** the sync-protocol shape, the pure metric functions (`run.ts`: haversine distance, pace, velocity, duration), the identity/encryption idea.
- **Replace:** browser js-waku → **native `liblogosdelivery`** (js-waku does NOT work in RN); timer `getCurrentPosition` → **background native GPS**; IndexedDB → native store; add **altitude/accuracy/HR** (Perun silently drops them).
- **Drop:** iExec/CoreDAO/NFT Proof-of-Run (never worked; hardcoded key).

## 3. Current Logos facts (verified 2026-07-13)

- **Basecamp** modules are desktop **Qt/QML** plugins running in isolated `logos_host` processes. Host is **Linux/macOS only** (iOS experimental, Android roadmap). Canonical authoring: `logos-co/logos-tutorial` (**tutorial-v4**) + `forum-sample-app`; `ui_qml` + `interface: "universal"` (now Qt-free `std` types + LIDL codegen) + `.rep` contract + one backend. `.lgx` (manifest schema **0.3.0**, Ed25519/`did:jwk` signing), packaged via **`lgpm`**.
- **`delivery_module` v0.1.3** (Jun 23): `createNode(cfgJSON)/start/stop/send(topic,payload)→reqId/subscribe/unsubscribe`; events `messageSent/messageError/messagePropagated/messageReceived(hash,topic,base64,ns)/connectionStateChanged`. **Payloads are base64 over the FFI, both directions.** Node `logos-delivery` v0.38.1 exposes the **`liblogosdelivery`** FFI lib (the thing we embed on mobile). **Waku 150 KB/message cap** — unchanged.
- **`storage_module` v2.0.1** (Jul 1): `init/start/stop`, `uploadUrl`/streaming upload, `downloadChunks`(base64)/`downloadManifest`, `exists/fetch/remove/space/manifests`, `togglePrivateQueries` (Mix). REST base path **`/api/storage/v1/data`** (was `/api/codex/v1`). `logos-storage-nim` v0.4.1 (**pre-alpha**). **Public testnet paused since Aug 2025 → run your own node.**
- **Reuse sources:** `xAlisher/receiver-android` (RN + `liblogosdelivery` JNI), `forum-sample-app` + `logos-tutorial` (module template), `logos-co/logos-storage-ui` (storage_module reference), Perun (`run.ts`, sync protocol), `logos-qt-mcp` (headless UI tests).

## 4. Architecture

```
PERUN MOBILE (React Native + liblogosdelivery JNI)     PERUN ANALYTICS (Basecamp ui_qml module)
────────────────────────────────────────────────      ─────────────────────────────────────────
 background GPS → track buffer (SQLite)                 delivery_module.subscribe(/perun/1/<id>/proto)
 metrics (ported from Perun run.ts)                       → base64 decode → decrypt(runKey)
 compact-encode + encrypt(runKey) + sign                  → verify sig → reassemble chunks
 delivery_module.send(topic, payload)   ───Delivery──►    → kv_module persist (ns "perun")
   (chunk if > ~120 KB)                                    → analytics: splits/elevation/HR/trends/PRs (QML charts)
 [opt] LAN HTTP fast-path to module      ─ ─ opt ─ ─►    [opt] storage_module backup (best-effort CID archive)
 QR / deep-link pairing                                  [opt] LAN HTTP receiver + Delivery-announced address
```

**One run, end to end:** phone records → compact-encodes → encrypts with the run key → signs → `send()`s a `RUN_META` message and one-or-more `TRACK_CHUNK` messages on `/perun/1/<runId>/proto`. The module subscribes, decrypts, verifies, reassembles, persists to `kv_module`, and renders analytics. No server, no Storage on the hot path. Storage backup is a later, module-side extra.

## 5. Wire contract (built first — see `docs/wire-contract.md` + `packages/contract/`)

The single artifact both halves depend on. Frozen before mobile/module work.
- **Topics (LIP-23):** `/perun/1/<runId>/proto` (per-run: meta + track chunks + optional live points), `/perun/1/pairing/proto` (pairing handshake).
- **Envelope:** `{ v, type, runId, sender, ts, sig, seq?, total?, payload }` where `type ∈ {RUN_META, TRACK_CHUNK, LIVE_POINT, DELETE}`.
- **Track blob:** compact binary — header + delta-encoded points (lat/lon as 1e7 fixed-point zig-zag varint deltas, timestamp/altitude/hr varint deltas). Reference codec + benchmark in `packages/contract/`. **Validated:** a 1 h @1 Hz run ≈ ~50–60 KB (< 150 KB); marathon @1 Hz chunks into 2–3 messages.
- **Encryption:** per-run symmetric key (e.g. `HKDF("perun/track/v1", sharedSecret)`), AES-256-GCM; detached signature by sender key.

## 6. Mobile app (record + basic view)

- **Framework:** React Native (bare or Expo dev-build — needs a custom native module for `liblogosdelivery`, so a bare/dev-build workflow, not Expo Go).
- **Delivery:** adapt `receiver-android`'s JNI bridge to `liblogosdelivery` (arm64-v8a `.so`); JS API `send/subscribe`; cluster/preset config for our own fleet.
- **GPS:** background location (foreground service on Android) capturing lat/lon/alt/accuracy/speed; optional BLE HR.
- **Store:** SQLite/MMKV behind Perun's thin store interface (fix the `getAll` bug on port).
- **Map/UI:** MapLibre or `react-native-maps` polyline; live speed/elapsed; run list; post-run scalar overview (reuse `run.ts` metrics).
- **Sync:** compact-encode → encrypt → `send()`; chunk long runs; pairing via QR/deep-link.

## 7. Basecamp analytics module (detailed analytics)

- **Template:** `logos-tutorial`/`forum-sample-app` — `ui_qml`, `interface: universal`, `.rep` contract + one backend; `metadata.json` deps `["delivery_module"]` (+`["storage_module"]` when backup lands). Surface `appVersion` from metadata; build via `logos-module-builder` → `.lgx`.
- **Delivery:** subscribe to `/perun/1/<id>/proto`; `.on("messageReceived")` **before** `start()`; handle the **shared-singleton** node (createNode may already be done → fall through to subscribe); **defer bootstrap off `onContextReady()`**; **base64-decode** payloads.
- **Persistence:** `kv_module` ns `perun`, keys `run:<id>` / `points:<id>` / index `runs`; `toJson/fromJson`; encrypt at rest.
- **Analytics (the value):** per-km/pace **splits**, **elevation profile**, **HR zones**, pace/speed curves, cross-run **trends**, **PRs**, full-track **map**, activity heatmap. QML charts (apply the dataviz method when building).
- **Storage backup (optional):** `storage_module.uploadUrl` a run archive → keep CID in kv as a restore pointer. Best-effort; framed honestly.
- **Testing:** `logos-qt-mcp` headless UI tests (Xvfb + software renderer on crib); JSON round-trip unit tests; two-instance `--user-dir` E2E for the sync path.

## 8. Data model

```ts
GeoPoint = { lat, lon, alt?, acc?, speed?, hr?, t }          // t = epoch ms; add alt/acc/hr (Perun drops them)
RunSummary = { distance_m, duration_s, avgPace, avgSpeed, elevGain?, avgHr? }
Run  = { id, name, startTs, finishTs, deviceId, ownerId, summary }   // cache summary on the record
Track = { runId, points: GeoPoint[] }                        // encoded to the compact blob for transport/storage
```

## 9. Phased roadmap

- **Phase 0 — Wire contract + infra (now).** Freeze topics/envelope/track-blob; reference codec + size benchmark (**done, this iteration**); stand up our own `logos-delivery` node reachable by phone + module; tiny CLI that publishes/receives a fake run over real Delivery. *Exit: fake run round-trips over real Delivery.*
- **Phase 1 — Basecamp module MVP.** Scaffold from tutorial template; subscribe → decrypt → persist → run list + one detail view (map + splits). Headless tests. *Exit: module ingests the CLI's fake run and shows splits.*
- **Phase 2 — Mobile capture MVP.** RN app: background GPS (+alt/acc), live map/stats, local store, run list/overview. *Exit: record a real run, view locally.*
- **Phase 3 — liblogosdelivery on mobile + wire the bridge.** JNI integration (adapt receiver-android); compact-encode → encrypt → send; pairing. *Exit: record on phone → analytics in Basecamp over Delivery.*
- **Phase 4 — depth + polish.** Elevation/HR charts, trends, PRs, heatmap; `.lgx` release; optional Storage backup; optional LAN HTTP fast path; iOS.

## 10. Risks
- **`liblogosdelivery` on mobile** is the biggest unknown — mitigate by adapting Alisher's working `receiver-android` bridge early (Phase 3, but spike in Phase 0).
- **We run the infra** (Delivery node; Storage node if/when backup) — testnet is not a reliable public dependency.
- **Background GPS** platform friction (iOS background modes, Android foreground service, battery).
- **Delivery payload base64 + 150 KB cap** — compact encoding + chunking are load-bearing; the codec benchmark de-risks this.
- **Module third-party IPC** (dependency auto-load / token bootstrap for non-stock modules) — validate the `delivery_module` dependency loads early.
