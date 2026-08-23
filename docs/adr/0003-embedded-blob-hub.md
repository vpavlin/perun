# 3. The module embeds the media blob hub (autostarts with it)

- **Status:** accepted
- **Date:** 2026-08-23

## Context

Photo/voice annotations need a place to store their (sealed) bytes so a second device can
fetch what it did not author ([ADR 0002](0002-local-first-content-addressed-blobs.md) put
this behind a swappable `BlobBackend`). The first cut was a standalone HTTP server
(`perun/server/server.mjs`) that had to be deployed and pointed at separately — one more
process to run and configure, and nothing ran it by default.

The desktop Basecamp instance is already the household's always-open peer (it holds the
runs, the pairing key, and decrypts media for display). Making *it* the media hub removes
the separate process entirely.

## Decision

The `perun_analytics` Basecamp module **embeds a content-addressed blob server**
(`blob_server.{h,cpp}`) that **autostarts with the module**. It is a tiny HTTP/1.1 server
over `QTcpServer` (Qt::Network, already linked — no `QHttpServer` dependency) speaking the
exact contract the mobile `BlobBackend` already uses:

```
POST /blob        body = sealed bytes            -> 200 {"id":sha256hex(body),"size":N,"dedup":bool}
GET  /blob/<id>   id = 64-hex sha256 of the body -> 200 application/octet-stream (sealed bytes)
GET  /healthz                                    -> 200 ok
```

- **Zero-trust**: stores and serves only ciphertext, addressed by `sha256(sealed)` == the
  mobile "cid". Optional bearer on writes; reads open (unguessable id + ciphertext).
- **Port** `PERUN_BLOB_PORT` (default 8087), OS-assigned fallback if taken.
- **Local-first display**: `loadMedia` reads a blob straight from the module's own sealed
  store and decrypts it — no HTTP round-trip to itself. `decryptSealedToCache` is shared by
  the local-store path and the remote-fetch path.
- The URL (`http://<lan-ip>:<port>`) is surfaced as the `blobServerUrl` PROP so the QML can
  show it as the address to set on the phone.

The mobile side is **unchanged** — its `HttpBlobBackend` already speaks this contract.

## Rejected

- **A standalone server process** (the `server.mjs` first cut) — one more thing to deploy,
  configure, and keep running; nothing started it by default.
- **A `QHttpServer` dependency** — cleaner code, but adds a Qt module that may not be in the
  build closure. `QTcpServer` + a minimal HTTP/1.1 handler needs nothing new.
- **Serving decrypted bytes** — would put plaintext on the wire; the hub only ever handles
  sealed bytes (the module decrypts locally for its own display).

## Consequences

- Two-device media works by pointing the phone's attachment URL at the desktop; no separate
  server to run.
- The hub lives for the module's lifetime in Basecamp — fine for "autostart with it", but it
  is not a standalone always-on daemon. An always-on hub argues for a headless node, which
  is the Logos Storage direction anyway ([ADR 0004](0004-logos-storage-direction.md)).
- The `BlobBackend` seam is unchanged, so this hub and a future Logos Storage backend are
  interchangeable without touching mobile, the annotations, the fold, or the UI.
- Trade-off owned: a hand-rolled minimal HTTP server — binary-body handling is the thing to
  watch on real uploads (logged as `blob received <id>` on success).
