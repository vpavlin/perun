# Perun ⇄ Basecamp wire contract (v2 — gzipped GPX)

The single source of truth both halves depend on. Transport is **Logos Delivery** (Waku). Reference/measurements: `packages/contract/` (`compare.mjs`).

## Format decision (why GPX)
Runs travel and persist as **standard gzipped GPX 1.1** (with the Garmin `TrackPointExtension` for HR). We measured GPX vs a bespoke compact codec: **raw GPX is ~20× too big, but gzipped GPX is only ~1.5× the compact codec** — still **one Delivery message for every normal run** (see table). In exchange we get **one standard format everywhere**: interoperable with Garmin watches / Strava (import + export come for free), and **no custom codec to port to each platform** (Kotlin/Swift on mobile). The old compact codec (`track-codec.mjs`, `track_codec.h`) is **retired**.

## Topics (LIP-23)
- `/perun/1/<ownerId>/proto` — the owner's run feed: `CHUNK` messages carrying gzipped-GPX runs. *(Currently a fixed `/perun/1/demo/proto` until identity/`accounts_module` lands.)*
- `/perun/1/pairing/proto` — device/peer pairing handshake (ports Perun's `request_pairing`→`confirm_sync`). *(Not yet implemented.)*

## Message envelope (implemented)
Each message is a small JSON object passed to `delivery_module.send(topic, payload)` (the module base64-wraps the payload across its FFI, so the effective Waku budget is ~150 KB × ¾ of raw bytes):

```
{ v:1, type:"CHUNK", id:<runId>, seq:<int>, total:<int>, gz:<base64> }
```
- A run is serialized to GPX → **gzipped** → split into `total` byte-chunks each ≤ ~100 KB raw (base64 stays under 150 KB) → one message per chunk.
- `gz` — base64 of this chunk of the gzipped-GPX bytes.
- The receiver buffers chunks by `id`; once all `total` are present it concatenates → **gunzips → parses GPX** → computes analytics → persists (keeping the gzipped GPX as the source of truth for the map + export).
- The run's **name** lives in the GPX `<trk><name>`; timestamps/HR/elevation are standard GPX fields.

## Sizes (measured — `node packages/contract/compare.mjs`, 2026-07-13)
```
case              pts | compact  msgs | gpx.gz  msgs | gz vs compact
30 min            1800 |   15K    1    |   24K    1   | 1.5x
1 h               3600 |   31K    1    |   48K    1   | 1.5x
2 h               7200 |   62K    1    |   93K    1   | 1.5x
marathon ~3.5h   12600 |  108K    1    |  161K    2   | 1.5x
100k ultra       36000 |  310K    3    |  458K    5   | 1.5x
```
→ Normal runs = one message; only ultra-distance chunks. Round-trip is faithful (verified in the module: 3.83 km / 19:59 / 5:13 / 120 m / 135 bpm renders identically via GPX).

## Interop
- **Export**: the module's `exportGpx(runId)` writes a standard `.gpx` (gunzip of the stored blob) — uploadable to Strava/Garmin.
- **Import** (mobile, later): any GPX (Garmin watch / Strava export) → gzip → send. No conversion needed — the wire format *is* GPX.

## Open (not yet implemented)
- **Encryption**: per-run key `HKDF-SHA256(sharedSecret, "perun/track/v1")`, AES-256-GCM on the gzipped-GPX bytes; detached signature by the sender key. (Content is currently plaintext-over-relay for the demo.)
- **Identity + per-owner topic**: `accounts_module` pubkey → `ownerId` in the topic (currently fixed `demo`).
- **Pairing** handshake; **LIVE_POINT** stream for real-time follow.
