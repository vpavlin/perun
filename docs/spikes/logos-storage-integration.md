# Spike: depend on the Logos Storage (Codex) module for media

**Status:** prototype / spike (branch `spike/logos-storage`) — NOT merged.
**Goal:** replace Perun's embedded HTTP blob hub ([ADR 0003](../adr/0003-embedded-blob-hub.md))
with a dependency on the real **`storage_module`** (Codex), wired and called the same way
Perun already depends on `loam_core`.

## What `storage_module` is

- Repo: **`github.com/logos-co/logos-storage-module`** — a Logos Core module (`type: core`,
  `interface: universal`, name **`storage_module`**, v2.1.2) that wraps a **Codex** node
  (`libstorage`). Codex is Logos's content-addressed durability network: every object is
  addressed by a **CID**.
- It's a normal inter-module dependency: an app declares `"storage_module"` in
  `metadata.json` dependencies + a flake input `github:logos-co/logos-storage-module`,
  and calls it through the generated `modules().storage_module.*` proxy + `.on(event)` —
  exactly the pattern Perun uses for `loam_core` (`modules().loam_core.sendSealed(...)` /
  `.on("received", …)`).

### Interface (from `src/storage_module_plugin.h`)

Synchronous (return `StdLogosResult`, surfaced as `QString`/value on the Qt caller):
- `init(cfg)` — create + configure the node (JSON cfg: `data-dir`, `network`,
  `storage-quota`, `listen-port`, …). Call once.
- `exists(cid) -> bool`, `version()`, `dataDir()`, `peerId()`, `spr()`, `debug()`.

Asynchronous (accepted immediately; completion via a typed event carrying a JSON string):
- `start()` → `storageStart`; `stop()` → `storageStop`.
- **Upload** — `uploadUrl(filePath, chunkSize)` streams a file, `storageUploadProgress`
  then `storageUploadDone` (payload carries the **CID**). Or manual streaming:
  `uploadInit(filename, chunkSize)` → sessionId, `uploadChunk(sessionId, chunk)`,
  `uploadFinalize(sessionId)` → **CID**.
- **Download** — `downloadToUrl(cid, filePath, local, chunkSize)` → `storageDownloadProgress`
  then `storageDownloadDone`; `downloadChunks(cid, local, chunkSize)` streams chunks;
  `local=false` fetches from the network if not held locally.
- `fetchManifest` → `storageDownloadManifestDone`; `remove` → `storageRemoveDone`.

## How Perun would use it (desktop)

The module's `BlobBackend` role (store sealed bytes → id; fetch by id → sealed) maps onto
Codex file upload/download, reusing the existing sealed-blob + `decryptSealedToCache`
plumbing ([ADR 0002](../adr/0002-local-first-content-addressed-blobs.md)):

**Store** (authoring/replicating media):
1. Write the sealed bytes to a temp file.
2. `modules().storage_module.uploadUrl(tmpPath, 65536)`.
3. On `storageUploadDone`, read the **CID** from the event payload → that CID is the
   annotation's `blobId`.

**Fetch** (displaying a peer's media):
1. `modules().storage_module.downloadToUrl(cid, tmpPath, /*local=*/false, 65536)`.
2. On `storageDownloadDone`, read the sealed bytes from `tmpPath` → `decryptSealedToCache`
   → `mediaReady`.

Init/start once at module bring-up (a Codex node in the same process), mirroring how
`startBlobServer()` autostarts the embedded hub today. Selected by
`PERUN_STORAGE_BACKEND=logos` so the embedded hub stays the default until this is proven.

The prototype call sites are in `module/src/storage_backend.{h,cpp}` on this branch.

## The load-bearing finding: CID identity vs. local-first

This is the real reason to spike before committing. Today `blobId = sha256(sealed)` is
computed **locally and instantly**, so an annotation is authored offline the moment media
is captured, and replication is a best-effort afterthought (local-first — ADR 0002).

**Codex mints its own CID, and only *after* an upload completes.** A Codex CID is a hash
over the chunked/erasure-coded object, not a plain `sha256(sealed)`, so it can't be
precomputed cheaply on-device. That breaks the "author immediately with a known id" flow.
Three ways to reconcile, to decide before adopting:

1. **Two ids (recommended).** Keep `blobId = sha256(sealed)` as the *local* handle
   (unchanged local-first authoring), and add an optional `storageCid` the uploader fills
   in via an `edit`-style event once Codex returns it. Peers fetch by `storageCid` when
   present; until then the media is simply "not yet fetchable elsewhere" (eventual, and
   fine — the note/metadata already synced). Determinism still holds: identical sealed
   bytes → identical Codex CID → dedup.
2. **Codex-CID as the only id.** Simplest wire, but authoring media now *blocks on upload*
   (needs a reachable Codex node at capture time) — a real regression to local-first, and
   worse on mobile/cellular.
3. **Gateway precompute.** Ask a Codex node to compute a CID without persisting — not part
   of the current API; rejected.

The spike implements (2)'s call mechanics to prove the wiring, but the **recommendation is
(1)**: the `storageCid` sidecar keeps ADR 0001/0002 intact and makes Codex a *replication*
target, not a capture-path dependency — the same stance the embedded hub takes.

## Risks to verify (why this stays a spike)

- **SDK/ABI alignment.** Perun pins `logos-module-builder/0.2.6` (and `loam_core` follows
  it). `storage_module` builds against `logos-cpp-sdk` (`feat/logos-result`). Whether the
  generated `modules().storage_module` proxy is ABI-compatible under Perun's pins is
  unverified — the first thing to check when building this branch. If they diverge, align
  the pins (or have `storage_module.inputs` follow Perun's builder/sdk).
- **A Codex node per desktop.** `init`+`start` runs a real Codex node (disc-port, quota,
  network `logos.test`). That's heavier than the embedded hub and needs its own config +
  lifecycle. For "autostart with the module" it's acceptable; for always-on it argues for a
  headless node instead.
- **Mobile.** This spike is desktop-only. The phone would talk to Codex via its own node or
  a gateway (`logos-storage-js`/`-py-api-client`) behind the same mobile `BlobBackend`
  seam — unchanged contract, separate work.

## Bottom line

`storage_module` is a clean drop-in as a *dependency* and the call pattern is identical to
`loam_core`. The one design decision that must precede adoption is **CID identity** — take
the two-id `storageCid` sidecar so Codex stays a replication backend and local-first
survives. Everything below the mobile/desktop `BlobBackend` seam is swappable without
touching annotations, the fold, or the UI.
