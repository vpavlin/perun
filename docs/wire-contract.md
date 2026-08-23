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

---

# Sport vs category — the GPX `<type>` mapping (decided 2026-07-15)

Two orthogonal dimensions want one standard field:
- **sport** — running / trail / walking / hiking / cycling / mtb. Drives GPS filtering and
  whether we show pace or speed. Must be known **at record start** (see below).
- **category** — the training intent: Easy / Long / Tempo / Intervals / Race / Recovery / custom.
  Post-hoc, Perun-specific.

**Decision: `<trk><type>` carries the SPORT** — that is what the field means, and it makes
Strava/Garmin import a ride as a ride. The category moves to a Perun extension:
```xml
<trk>
  <name>Morning run</name>
  <type>running</type>                          <!-- sport: standard, 3rd parties read this -->
  <extensions><perun:category>Tempo</perun:category></extensions>
  <trkseg>…</trkseg>
</trk>
```
Namespace: `xmlns:perun="https://github.com/vpavlin/perun/1"`. Third parties ignore unknown
extensions, so export stays valid. Sport values use the lowercase GPX/Strava-ish vocabulary
(`running`, `trail_running`, `walking`, `hiking`, `cycling`, `mtb`); unknown → treat as running.

⚠️ **Migration:** runs synced before this change carry the CATEGORY in `<type>` (e.g. `Long`).
On parse, a `<type>` that isn't a known sport is treated as a category, not a sport — so old
runs degrade correctly instead of claiming to be a sport called "Long".

## Sport drives the GPS filter — this is not cosmetic
The recorder's outlier gate hard-codes `MAX_SPEED_MPS = 12` (~43 km/h), which is running-specific:
a cycling descent exceeds it and its fixes get **silently dropped**, corrupting the track. So the
sport MUST be selected before recording starts. Per-sport gates:

| sport | max plausible speed | note |
|---|---|---|
| walking / hiking | 5 m/s (18 km/h) | tighter gate catches more junk |
| running / trail | 12 m/s (43 km/h) | current value; > any runner |
| cycling | 30 m/s (108 km/h) | must survive fast descents |
| mtb | 25 m/s (90 km/h) | |

Display also follows sport: **pace (min/km)** for foot sports, **speed (km/h)** for cycling.

# v3 (planned) — mutable runs: `id` + `rev`

## The bug v2 has
v2 dedupes by `id` and **skips** anything already known (`addRun`: `if (existing.id == id) return;`).
That made ingest idempotent but runs **immutable**: renaming/recategorizing a run on the phone and
re-syncing is a **no-op** on the desktop — the message is dropped on the floor. Since v1.2.0 the
name/category ride inside the GPX (`<trk><name>`, `<trk><type>`), so the data is already on the
wire; only the receiver's skip prevents it landing.

## Fix: a per-run revision, last-write-wins
`id` stays the stable identity; **`rev`** (monotonic int, bumped on every edit) says which copy is
newer. Deliberately *not* a wall-clock `updatedAt` — devices' clocks skew, and `rev` is authored by
whoever made the edit. `ts` is carried for tie-breaks/debugging only, never for ordering.

```
{ v:3, type:"CHUNK"|"META"|"DELETE", id:<runId>, rev:<int>, ts:<epochMs>, …payload }

CHUNK  → seq, total, gz     # full run; name/category ride inside the GPX
META   → name, category     # metadata-only delta, no track (~200 B vs ~11 KB)
DELETE → –                  # tombstone
```

### Receiver rules (LWW by `rev`)
- **CHUNK** → reassemble, then: unknown `id` ⇒ insert · `rev` > stored ⇒ **replace** ·
  `rev` ≤ stored ⇒ ignore (idempotent replay — Waku Store *will* redeliver) ·
  tombstoned at `rev'` ≥ incoming ⇒ ignore (never resurrect a deleted run).
- **META** → known `id` and `rev` > stored ⇒ patch name/category. Unknown `id` ⇒ drop; harmless,
  because the next CHUNK carries the same metadata inside its GPX.
- **DELETE** → `rev` > stored ⇒ remove + remember tombstone `(id, rev)`.

⚠️ **Reassembly must key on `(id, rev)`, not `id`.** v2 buffers chunks by `id` alone, so an edit
mid-transfer would splice chunks from two different revisions into one corrupt gzip stream.

### Sender rules (phone)
- Each run carries `rev` (starts at 1) and `syncedRev` (last rev the desktop was told).
- Any name/category edit ⇒ `rev++`.
- Sync: never synced ⇒ **CHUNK**s · only metadata changed since `syncedRev` ⇒ **META** ·
  track changed (e.g. GPX re-import) ⇒ **CHUNK**s. On success `syncedRev = rev`.

### Why META is worth the extra type
Re-sending a whole run to fix a typo costs ~11 KB and a re-gzip; META is ~200 B — **~50× cheaper**
for a normal run, ~250× for an ultra (5 chunks). CHUNK-replace alone would be correct but wasteful.

### IDs
New runs get a **UUIDv4** (`expo-crypto`'s `randomUUID`). Existing `run-<epochMs>` ids stay valid —
they're opaque strings — so no migration. Rationale: `Date.now()` can collide across devices and
encodes the recording time in the id (moot once payloads are encrypted, but free to fix).

### Compatibility
The current module ignores any `type != "CHUNK"` and never inspects `v`, so v3 `META`/`DELETE` are
safely ignored by a v2 receiver. But **rev-replace requires the module change** — a v2 module keeps
skipping known ids no matter what the phone sends.

### Multi-device — what works and what does not (verified 2026-07-15)
**Many READERS work; a second WRITER does not.** Several Basecamps can share the secret,
derive the same topic and each receive the phone's runs — LWW by `rev` is well-behaved with
exactly one writer.

A second *phone* fails for three independent reasons, any one of which is sufficient:
1. **The phone never ingests.** `onMessage` is exported in `delivery.ts` and called nowhere —
   the phone is send-only. Two phones would both publish and neither would ever see the other.
2. **`rev`-only LWW splits silently.** Two devices edit the same run at rev 1 → both publish
   rev 2 → the receiver keeps whichever lands first and drops the second (`rev <= storedRev`).
   The devices then disagree permanently, with no error and no convergence.
3. **Run ids are `"run-" + Date.now()`** (App.tsx) — no device component, so they carry no
   author identity, which is exactly what a tie-break needs.

To fix, in order: wire `onMessage` → reassemble → gunzip → `fromGpx` → LWW store on the phone
(mirrors what the module already does); then upgrade `rev` to a Lamport pair `(rev, deviceId)`
with deterministic tie-break — the envelope carries `ts` and would gain `dev`. **That second
step is a wire break: both ends must ship together.**

### Backfill — blocked upstream, workaround available
A device only sees messages published **while it is subscribed**: `liblogosdelivery.so`
exposes no Store/history query (see `research-notes.md` → Delivery capability gaps). So a
newly-installed Basecamp sees nothing that already exists, and a phone reinstall loses its
runs — **the phone's local storage is currently the only durable copy**. Workaround needing
nothing upstream: republish-on-demand over the existing CHUNK envelope.

## Annotations (implemented)
Journey annotations — text / photo / voice notes pinned to a point on a run — travel as
their own sealed envelope, one event per note/edit/delete (append-only CRDT). Dedup by
`a.id`; `kind:"delete"` is a tombstone removing `a.target`; `kind:"edit"` supersedes
`a.target`'s text/caption (LWW by `createdAt`). Media bytes do NOT ride the
wire: `blobId` is a content id (`sha256` of the sealed bytes) resolved via a local-first
blob store, best-effort replicated to a swappable backend. See
[`adr/0001`](adr/0001-journey-annotations-as-an-event-log.md) and
[`adr/0002`](adr/0002-local-first-content-addressed-blobs.md).

```
{ v:1, type:"ANNOTATION", a:{ id, runId, lat, lon, ele, t, createdAt, author,
                              kind:"text"|"photo"|"voice"|"delete"|"edit",
                              text?, blobId?, mime?, dur?, target? } }
```

Sealed + sent exactly like a `CHUNK` (household key, AAD = topic). Like runs, there is no
cold-start backfill (Delivery has no Store query) — a device only receives annotations
authored while subscribed, plus local re-sends of unsynced ones.

## Open (not yet implemented)
- **Module→phone real runs**: the module *can* publish (`sendChunks`) but it is only wired to
  `publishSampleRun()` (the demo button). No real run travels desktop→phone.
- **LIVE_POINT** stream for real-time follow.
- **Identity + per-owner topic** via `accounts_module` pubkey — superseded in practice by the
  PSK-derived topic; would only matter for social/sharing features.

## Done (was listed as open)
- **Encryption** — shipped, but NOT as sketched here: `ChaCha20-Poly1305` (not AES-256-GCM),
  key `Ke = HKDF-SHA256(K, info="perun/payload/v1")`, `nonce(12) ‖ ciphertext`, `aad = topic`.
  No detached signature: the PSK authenticates both ends. See `pairing-crypto.md`.
- **Pairing** — QR-shared 32-byte secret + pgp_words fingerprint; topic derived via
  `HMAC-SHA256(K, "perun/topic/v1|"+epoch)`, so the topic is no longer the fixed `demo`.
