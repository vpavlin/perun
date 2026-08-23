// Perun blob server — a tiny, zero-dependency, content-addressed object store for
// the large journey attachments (photos, voice notes) that are too big to sync over
// Waku/Delivery. Metadata (the annotation: point, kind, text, blobId) syncs via
// Delivery; the binary lives here, referenced by blobId = sha256(bytes).
//
// ZERO-TRUST: clients SEAL blobs (the run's household key) BEFORE upload, so the
// server only ever holds ciphertext — it never sees photos/voice in the clear.
// Content-addressed ⇒ immutable, deduped, integrity-checked (the id IS the hash).
//
//   POST /blob            body = (sealed) bytes; Content-Type preserved → { id, size, mime, dedup }
//   GET  /blob/:id        → the bytes (with stored Content-Type)
//   HEAD /blob/:id        → 200 if present, 404 otherwise
//   GET  /healthz         → "ok"
//
// Config (env): PERUN_BLOB_PORT (8090), PERUN_BLOB_DATA ($HOME/.perun-blobs),
//   PERUN_BLOB_TOKEN (optional Bearer required for POST; reads stay open — the id
//   is unguessable + the payload is ciphertext), PERUN_BLOB_MAX (bytes, default 50MB).
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { promises as fs, createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT = Number(process.env.PERUN_BLOB_PORT || 8090);
const DATA = process.env.PERUN_BLOB_DATA || join(homedir(), ".perun-blobs");
const TOKEN = process.env.PERUN_BLOB_TOKEN || "";
const MAX = Number(process.env.PERUN_BLOB_MAX || 50 * 1024 * 1024);
const isHash = (s) => /^[0-9a-f]{64}$/.test(s);

await fs.mkdir(DATA, { recursive: true });

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
const send = (res, code, body, headers = {}) => { cors(res); res.writeHead(code, headers); res.end(body); };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    if (req.method === "OPTIONS") return send(res, 204, "");
    if (path === "/healthz") return send(res, 200, "ok\n", { "Content-Type": "text/plain" });

    // POST /blob — store sealed bytes, keyed by their sha256.
    if (req.method === "POST" && path === "/blob") {
      if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`)
        return send(res, 401, JSON.stringify({ error: "unauthorized" }), { "Content-Type": "application/json" });
      const chunks = []; let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX) { req.destroy(); return send(res, 413, JSON.stringify({ error: "too large", max: MAX }), { "Content-Type": "application/json" }); }
        chunks.push(c);
      }
      const buf = Buffer.concat(chunks);
      if (!buf.length) return send(res, 400, JSON.stringify({ error: "empty body" }), { "Content-Type": "application/json" });
      const id = createHash("sha256").update(buf).digest("hex");
      const mime = req.headers["content-type"] || "application/octet-stream";
      const file = join(DATA, id);
      let dedup = true;
      try { await fs.access(file); } catch { dedup = false; await fs.writeFile(file, buf); await fs.writeFile(file + ".type", mime); }
      return send(res, 200, JSON.stringify({ id, size: buf.length, mime, dedup }), { "Content-Type": "application/json" });
    }

    // GET/HEAD /blob/:id — serve the bytes.
    const m = path.match(/^\/blob\/([0-9a-f]{64})$/);
    if ((req.method === "GET" || req.method === "HEAD") && m && isHash(m[1])) {
      const file = join(DATA, m[1]);
      let stat; try { stat = await fs.stat(file); } catch { return send(res, 404, JSON.stringify({ error: "not found" }), { "Content-Type": "application/json" }); }
      let mime = "application/octet-stream"; try { mime = (await fs.readFile(file + ".type", "utf8")) || mime; } catch {}
      cors(res);
      res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size, "Cache-Control": "public, max-age=31536000, immutable" });
      if (req.method === "HEAD") return res.end();
      return createReadStream(file).pipe(res);
    }

    return send(res, 404, JSON.stringify({ error: "not found" }), { "Content-Type": "application/json" });
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: String(e && e.message || e) }), { "Content-Type": "application/json" });
  }
});
server.listen(PORT, () => console.error(`[perun-blob] listening on :${PORT} data=${DATA} auth=${TOKEN ? "on" : "off"} max=${MAX}`));
