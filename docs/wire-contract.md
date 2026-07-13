# Perun ⇄ Basecamp wire contract (v1)

The single source of truth both halves depend on. Frozen before mobile/module work. Transport is **Logos Delivery** (Waku). Reference implementation + benchmark: `packages/contract/`.

## Topics (LIP-23)
- `/perun/1/<runId>/proto` — per-run channel: `RUN_META`, `TRACK_CHUNK`(s), optional `LIVE_POINT`, `DELETE`.
- `/perun/1/pairing/proto` — device/peer pairing handshake (ports Perun's `request_pairing`→`confirm_sync`).

`runId` = 16-byte id (hex), e.g. first 16 bytes of `sha256(ownerPub || startTs)`.

## Message envelope
Bytes passed to `delivery_module.send(topic, payload)`. The module **base64-encodes** the payload across its FFI, so the effective Waku budget is **~150 KB × ¾ of raw bytes**. Keep raw chunks ≤ **~112 KB** (`RAW_CHUNK_BUDGET`).

```
{ v:1, type, runId, sender, ts, seq?, total?, sig, blob }
```
- `type` ∈ `{RUN_META=1, TRACK_CHUNK=2, LIVE_POINT=3, DELETE=4}`
- `sender` — owner public key; `sig` — detached signature over the (encrypted) blob + header
- `seq`/`total` — chunk index/count for `TRACK_CHUNK` (omit when a run is a single message)
- `blob` — the payload, **AES-256-GCM encrypted** with the per-run key

## Encryption
- Per-run symmetric key: `runKey = HKDF-SHA256(sharedSecret, "perun/track/v1")`. `sharedSecret` established at pairing (QR/deep-link, as in Perun today).
- `blob = AES-256-GCM(runKey, nonce, plaintext)`; ~28 B overhead (nonce+tag). Content is private over plain relay — routing privacy (mix) is orthogonal and deferred.

## Track blob format (compact binary)
Header + delta-encoded points. Coordinates fixed-point 1e-7° (~1.1 cm), altitude decimetres, timestamps ms. Deltas zig-zag varint. Full spec in `src/track-codec.mjs`.
```
'P'(0x50) | version(1) | flags(1) | uvarint count | uvarint baseT
base:  svarint latE7 | svarint lonE7 | [svarint altDm] | [svarint hr] | [svarint speedCsm]
point: uvarint dT | svarint dLatE7 | svarint dLonE7 | [svarint dAltDm] | [svarint dHr] | [svarint dSpeedCsm]
flags: bit0 alt · bit1 hr · bit2 speed
```
- `RUN_META` payload: `{ id, name, startTs, finishTs, summary:{distance_m,duration_s,avgPace,avgSpeed,elevGain?,avgHr?} }` (small JSON/CBOR).
- `TRACK_CHUNK` payload: a track blob for a contiguous slice of points (`chunkTrack()` splits by `RAW_CHUNK_BUDGET`).

## Chunking rule
Encode the whole track; if `base64Len(raw) + envelope > 150 KB`, split with `chunkTrack(points, opts, RAW_CHUNK_BUDGET)` and send N `TRACK_CHUNK`s with `seq`/`total`. The receiver reassembles by `runId` + `seq`.

## Validation (benchmark evidence, 2026-07-13)
`node packages/contract/bench.mjs` — ~8.8 bytes/point, **lossless** (≤1.1 cm, exact ms, ≤5 cm alt):

| case | pts | raw | base64 | msgs |
|---|---|---|---|---|
| 30 min @1Hz | 1 800 | 15.4 KB | 20.5 KB | 1 |
| 1 h @1Hz | 3 600 | 31.1 KB | 41.5 KB | 1 |
| 2 h @1Hz | 7 200 | 61.9 KB | 82.5 KB | 1 |
| marathon ~3.5 h @1Hz | 12 600 | 108.3 KB | 144.5 KB | 1 |
| 100k ultra ~10 h @1Hz | 36 000 | 309.7 KB | 413.0 KB | 3 |

→ **Every normal run is a single Delivery message.** Only ultra-distance runs chunk. Storage is not required on the sync path (it stays an optional Basecamp-side backup).

## Open (non-blocking) items
- Wire format for `RUN_META` small payloads: CBOR vs JSON (leaning CBOR).
- Exact signature/HKDF scheme once identity is settled (`accounts_module` key vs ported ethers key).
- `LIVE_POINT` cadence for real-time follow (phase 4).
