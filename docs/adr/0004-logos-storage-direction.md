# 4. Logos Storage (Codex) is the media backend direction

- **Status:** proposed (spiked on branch `spike/logos-storage`)
- **Date:** 2026-08-23

## Context

The embedded blob hub ([ADR 0003](0003-embedded-blob-hub.md)) is a good household-LAN
default, but it is not durable beyond the desktop that runs it, and it is not always-on.
Logos has a first-class content-addressed storage layer — **Codex** (org `logos-storage`,
née `codex-storage`) — exposed to Basecamp as the **`storage_module`** core module
(`github:logos-co/logos-storage-module`). Adopting it makes media durable on the Logos
network and removes Perun's need to host anything.

Because media already sits behind a `BlobBackend` seam (ADR 0002), swapping the hub for
Codex is a backend change, not a rewrite.

## Decision

**Direction:** move the media backend to `storage_module`, depended on and called exactly
like `loam_core` — declared in `metadata.json` dependencies + a flake input, invoked via
`modules().storage_module.uploadUrl/downloadToUrl/exists(...)` with completion on
`.on("storageUploadDone"/"storageDownloadDone", …)`. Store the sealed bytes on Codex; fetch
by CID and decrypt through the existing `decryptSealedToCache`.

**Not yet adopted** — spiked, with two questions to resolve first (see
[`../spikes/logos-storage-integration.md`](../spikes/logos-storage-integration.md)):

1. **CID identity vs. local-first (load-bearing).** Codex mints its own CID, and only
   *after* an upload completes — it cannot be precomputed on-device like `sha256(sealed)`.
   Adopting Codex's CID as the only id would make media capture block on an upload, breaking
   local-first (ADR 0001/0002). **Resolution:** keep `blobId = sha256(sealed)` as the local
   handle and add an optional `storageCid` sidecar the uploader fills in after Codex returns
   it (a small `edit`-style event). Peers fetch by `storageCid` when present; Codex stays a
   *replication* target, not a capture-path dependency.
2. **SDK/ABI alignment.** Perun pins `logos-module-builder/0.2.6`; `storage_module` builds
   against `logos-cpp-sdk` (`feat/logos-result`). The generated proxy's ABI compatibility
   under Perun's pins is unverified — the first build gate.

## Rejected

- **Codex-CID as the only blob id** — simplest wire, but makes capture block on upload and a
  reachable Codex node; a local-first regression (worse on mobile/cellular).
- **Replacing the embedded hub outright now** — premature before the two questions above are
  answered; the hub remains the default, Codex behind `PERUN_STORAGE_BACKEND=logos`.

## Consequences

- Media becomes durable on the Logos network; the desktop no longer needs to host blobs.
- The mobile and desktop `BlobBackend` seams are unchanged; annotations, the fold, and the
  UI are untouched — only what sits below `put(cid)/get(cid)` changes.
- A Codex node runs per adopter (init/start/quota/config), heavier than the hub — which is
  itself an argument for a headless node for always-on durability.
