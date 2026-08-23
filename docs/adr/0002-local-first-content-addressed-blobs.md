# 2. Annotation media is local-first and content-addressed

- **Status:** accepted
- **Date:** 2026-08-23

## Context

Photo and voice annotations carry binary payloads far larger than Waku/Delivery's
~150 KB wire budget, so the bytes can't ride the `ANNOTATION` event ([ADR 0001](0001-journey-annotations-as-an-event-log.md)).
The first implementation put them on a small HTTP blob server and had capture UPLOAD to
it before saving the annotation — which made recording a voice note **fail with no
server configured**. That is backwards for a local-first app: the media is the user's,
it primarily lives on their device, and a server is only how other devices get a copy.

We also want the storage backend to be swappable: today a custom HTTP server, later a
**Logos Storage node**, with no change to the annotation/CRDT layer.

## Decision

Media is stored **on the device first and always**; the server is a best-effort
**replication** target, never on the capture path and never the source of truth.

**Content addressing (the "CID" the event links to):**

```
sealId = sha256(plaintext)                    // stable id → deterministic nonce
sealed = seal(id, sealId, plaintext, topic)   // ChaCha20-Poly1305, AAD = topic
cid    = sha256(sealed)                        // == the event's `blobId`
```

- **Hash the SEALED bytes, not the plaintext.** This keeps the store **zero-trust** (it
  only ever holds ciphertext) while STILL deduplicating: the seal is deterministic (its
  nonce derives from `sha256(plaintext)`, loam-sync ADR 0011), so the same file always
  yields the same sealed bytes → the same `cid`. Hashing plaintext would leak
  content-equality to the store and defeat zero-trust.
- **On disk we keep the PLAINTEXT** (this is the owner's own device), in the durable
  document dir keyed by `cid`, so rendering is instant with no per-view decrypt.
  Replication re-seals on demand (deterministic → identical bytes → identical `cid`), so
  ciphertext is never persisted locally.
- **Capture provisions a household key if none exists** (a "household of one"), because a
  `cid` needs the seal. So media works on a brand-new, unpaired, offline install — it
  does not force the pairing UI. Since the app currently derives "paired" from mere key
  existence, a first solo capture will make the indicator read paired on the next launch;
  a proper solo-vs-shared distinction is deferred. Pairing later adopts another secret;
  media captured under the old key stays readable locally but won't re-seal under the new
  key — an accepted edge.
- **Resolve is local-first:** render from the on-device copy; only if we don't have it
  (an annotation authored on another device) fetch the sealed bytes from the backend,
  decrypt, and cache the plaintext.

**Swappable backend.** The annotation layer only ever calls `put(cid, sealed)` /
`get(cid)` through a `BlobBackend` interface. Today's implementation is
`HttpBlobBackend` (the custom server, which keys by `sha256(body)` and returns the id we
assert against). A Logos Storage node is a new `BlobBackend` behind the same seam —
nothing above it changes.

## Rejected

- **Server as the source of truth (upload-then-save).** The bug this ADR fixes: capture
  failed with no server, and even a locally-recorded note showed "offline" because the
  only reader was the server.
- **Hashing plaintext for the CID.** Simpler dedup, but leaks content-equality to an
  untrusted store and breaks zero-trust.
- **Requiring pairing before any media capture.** Local-first means the note is saved on
  the device regardless; a self-owned household key is provisioned lazily instead.
- **Persisting the sealed copy locally too.** Redundant — the seal is deterministic, so
  the sealed bytes (and the `cid`) are reproducible from the plaintext on demand.

## Consequences

- Recording a note never depends on, or fails without, a server or a pairing.
- The server holds only ciphertext, addressed by a hash it can verify; a hostile server
  can't substitute content without failing the `cid` check on fetch.
- Replication is best-effort and retried (`replicateBlob` on author,
  `replicatePending` when the receiver comes up). A device fetches a peer's media
  on-demand when it first renders that annotation.
- Moving to a Logos Storage node is a backend swap under `getBackend()`, not a rewrite —
  the intended future direction.
