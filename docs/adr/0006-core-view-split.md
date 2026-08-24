# 6. Split the Basecamp module into `perun_core` (headless) + `perun_analytics` (view)

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Until now the Perun desktop side was a *single* Basecamp `ui_qml` module,
`perun_analytics`: one C++ backend (`perun_analytics_backend`) that did
**everything** — pairing/identity, the Delivery/`loam_core` transport, the sync
ingest + event-log fold (runs and annotations), the SQLite store, the embedded
blob (media) hub, GPX/gzip/analytics — *and* drove the QML view.

That monolith cannot run without a QML host. The consequences bit us directly:

- **No hub.** Every sibling app (kym, qaku, scala) has a headless **core** that
  runs in a `logos-hub` / `logoscore` daemon as an always-on peer. Perun had
  none, so there was **no always-on node subscribing Perun's shard**. Phone↔desktop
  sync depended entirely on the two endpoints meshing the fleet *directly and
  simultaneously* — fragile, and the reason "Connected · paired but nothing syncs"
  was so hard to pin down (there was nothing on our side to watch, and no relay to
  bridge them).
- **No headless testing.** We could not reproduce or observe sync without a full
  Basecamp GUI on a second machine.
- **No clean seam for identity.** loam-keycard (per-person signing) and future
  loam-sync/RBSR backfill want to live in a core the view merely renders.

kym/qaku/scala already solved this: a **`core` module** (`interface: "universal"`
— every public C++ method is auto-exposed, no `.rep`/`.lidl`; events in a
`logos_events:` header section; depends on `loam_core`) that is *both* the
always-on hub **and** the desktop view's backend, plus a thin view on top. This is
the charter's rule 1 (ship at parity) and rule 8 (prefer a module dependency; an
always-on need argues for a headless node).

## Decision

Split the desktop side into two modules, mirroring kym:

### `perun_core` — `type: core`, `interface: "universal"`, depends on `loam_core`
Owns **all non-visual state and logic**, and runs identically in Basecamp and in a
headless `logoscore` daemon:

- **Identity / pairing** — `perun_identity` (HKDF household key, topic derivation,
  seal/open, pgp-word fingerprint), `pair.key` persistence, `resetPairing`,
  `pairWithCode`.
- **Transport** — the `loam_core` facade (`start`/`setSenderId`/`join`/`sendSealed`
  + `received`/`statusChanged`). The delivery config now **matches kym_core's
  proven shape** (see Consequences).
- **Sync + fold** — CHUNK reassembly, gzip/GPX decode, the run fold and the
  append-only **annotation event-log** (dedup by id, delete = tombstone, edit =
  supersede LWW by `createdAt`).
- **Store** — the SQLite `run_store`.
- **Blob (media) hub** — the embedded content-addressed `PerunBlobServer`. Being in
  the core means the **hub also serves household media**, not just a desktop GUI.
- **GPX / gzip / geo / analytics** — parsing and splits/pace/elevation.

Exposed API (universal, JSON-string in/out; aggregated so the view makes O(1) calls
per refresh — charter's no-blocking-IPC rule):

| method | purpose |
|---|---|
| `snapshot()` | one JSON blob: `status`, `ready`, `fingerprint`, `pairingUri`, `runs`, `annotations`, `blobServerUrl` — the view polls this |
| `trackJson(runId)` | decoded track points for the map |
| `addAnnotation(json)` | author+seal+send a note (create) |
| `publishSampleRun()` | synth run → gzip GPX → chunk + send |
| `exportGpx(runId)` | write a `.gpx`, return path |
| `getMedia(blobId, mime)` | fetch+decrypt a blob → base64 plaintext (view caches to its sandbox) |
| `configureBlobServer(url, token)` | set+persist the replication backend |
| `resetPairing()` / `pairWithCode(code)` | rotate / adopt a household secret |
| `metricsJson()` | passthrough of the delivery node metrics (debugging) |

Events (`logos_events:`): `runsChanged`, `annotationsChanged`, `statusChanged`.
Emitted for event-capable hosts; the desktop view **polls `snapshot()`** and does
not rely on them (events are unreliable on desktop — same finding as kym/scala).

**Hub mode** (headless), mirroring kym_core:
- `PERUN_CORE_DATA` — data dir (else `$HOME/.perun-core`); holds `runs.db`,
  `pair.key`, `blob.json`, `blobs/`.
- `PERUN_DEVICE_ID` — SDS senderId / author id (else a persisted friendly name).
- `PERUN_HUB` — enables a self-driven `QTimer` (headless has no view to pump the
  bootstrap poll) and writes a `<dataDir>/hub.json` heartbeat; sets `hubMode` on the
  loam cfg.
- `PERUN_DELIVERY_CFG` — a JSON override merged over the default cfg (inject
  `entryNodes` for a hub without a rebuild).

### `perun_analytics` — `type: ui_qml`, depends on `perun_core`
Stays the QML view **plus a thin C++ backend**, but the backend no longer does any
sync/identity/store work. It:
- polls `modules().perun_core.snapshot()` on a timer and mirrors the result into its
  existing QtRO PROPs (`status`/`runsJson`/`annotationsJson`/`fingerprint`/
  `pairingUri`/`blobServerUrl`) — so **the QML is essentially unchanged**;
- forwards commands (`addTextAnnotation`, `publishSampleRun`, `exportGpx`,
  `resetPairing`, `configureBlobServer`) to `perun_core`, then refreshes;
- keeps the **sandbox-coupled presentation** it already owns: OSM tile fetch/cache
  (`setTileRoot`/`ensureTile`), media-file caching (`loadMedia` now pulls decrypted
  bytes from `perun_core.getMedia` and writes them into the view sandbox), and QR
  encoding (`qrMatrix`, presentational).

Why keep a view backend rather than go pure-QML like kym/scala: perun renders a
**map** and plays back **media files**, both of which the Basecamp QML sandbox will
only read as `file://` under the plugin's own dir. That caching is inherently
view-side, and the charter explicitly models a Basecamp module as *QML view + C++
backend*. All the *logic* still moves to the core; the view backend shrinks to a
proxy + sandbox cache.

## Rejected alternatives

- **Pure-QML view (kym/scala style).** Cleanest, but perun's map tiles and decrypted
  media need a `file://` sandbox cache a pure-QML view can't produce. Revisit if the
  Basecamp sandbox ever allows `http://localhost` image loads from the core's blob
  server.
- **Keep the monolith, add a `PERUN_HUB` headless flag to the `ui_qml` module.**
  Tried in spirit (0.7.x); a `ui_qml` module isn't loaded headless by `logoscore`
  (only `core` modules are), and it drags QtQuick into the daemon. A real `core`
  module is the ecosystem-blessed path.
- **A second, separate hub binary.** Duplicates the engine; diverges from the wire.
  The core *is* the hub.

## Consequences

- **Sync robustness.** A `perun_core` hub can run always-on (one or many), giving
  Perun's shard a persistent relay + a place to observe sync — exactly what was
  missing when "paired but no sync" was undiagnosable.
- **Delivery config corrected.** perun_core adopts kym_core's **proven** cfg:
  `{mode:Core, preset:logos.test, messagingOverrides:{logLevel, tcp-port:30303,
  discv5-udp-port:9000}}` — a **fixed** discv5 UDP port (ephemeral `0`, added in
  0.7.x to dodge a port clash on a test box, breaks discv5 discovery → 0 peers), no
  bare top-level `entryNodes` (the strict v0.2.0 parser rejects them; the preset's
  discv5 bootstrap meshes the fleet; a hub injects entryNodes via
  `PERUN_DELIVERY_CFG`).
- **Wire unchanged.** Same envelopes, same household sealing (ADR 0001/0002), same
  topic. The mobile app is untouched; a `perun_core` peer folds the same log off the
  same wire.
- **Version skew is now a thing** (as with kym): a new view method needs the core
  updated too. Both `.lgx` publish to the repo; Basecamp installs both (the view
  declares `perun_core` as a dependency).
- **Opens** loam-keycard per-person signing and loam-sync/RBSR cold-start backfill as
  core-local changes the view never sees.

See [0001](0001-journey-annotations-as-an-event-log.md) (the fold the core now owns),
[0003](0003-embedded-blob-hub.md) (the hub the core now hosts), and the kym_core
module for the reference implementation of the headless-core + thin-view pattern.
