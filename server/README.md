# perun-blob-server

A tiny (zero-dependency Node) **content-addressed** object store for Perun's large
journey attachments — photos and voice notes that are too big to sync over
Waku/Delivery. The *annotation metadata* (map point, kind, text, `blobId`) still syncs
peer-to-peer over Delivery; only the binary lands here, referenced by
`blobId = sha256(bytes)`.

**Zero-trust.** Clients **seal** each blob with the run's household key *before* upload,
so the server only ever stores ciphertext — it never sees photos/voice in the clear.
Content-addressing makes blobs immutable, deduplicated, and integrity-checked.

## API
| method | path | body / result |
|---|---|---|
| `POST` | `/blob` | body = (sealed) bytes, `Content-Type` preserved → `{ id, size, mime, dedup }` |
| `GET`  | `/blob/:id` | the stored bytes (with `Content-Type`); `:id` is the 64-hex sha256 |
| `HEAD` | `/blob/:id` | `200` if present, `404` otherwise |
| `GET`  | `/healthz` | `ok` |

## Config (env)
- `PERUN_BLOB_PORT` — listen port (default `8090`)
- `PERUN_BLOB_DATA` — storage dir (default `$HOME/.perun-blobs`)
- `PERUN_BLOB_TOKEN` — if set, `POST` requires `Authorization: Bearer <token>` (reads stay open — the id is unguessable and the payload is ciphertext)
- `PERUN_BLOB_MAX` — max upload bytes (default `52428800` = 50 MB)

## Run
```
node server.mjs
# or, as an always-on user service:
cp perun-blob.service ~/.config/systemd/user/ && systemctl --user enable --now perun-blob
```
Clients point at it via the app's **blob-server URL** setting.
