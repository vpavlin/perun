// Content-addressed, end-to-end-sealed attachment store (photos / voice notes).
//
// The journey attachment binary is too big for Waku/Delivery, so only the ANNOTATION
// metadata (point, kind, blobId, mime) syncs on the wire; the bytes live on a small
// HTTP blob server (see perun/server/server.mjs). ZERO-TRUST: we SEAL the bytes with
// the pairing key BEFORE upload, so the server only ever holds ciphertext.
//
// Content-addressing + deterministic sealing (identity.ts nonce is derived from the
// seal id) ⇒ the same original file P always yields the same sealed bytes ⇒ the same
// blobId ⇒ the server dedups it. blobId = sha256(sealed), and the server returns the
// same value (it keys files by sha256 of the body); we ASSERT they match.
//
//   sealId = sha256hex(P)                       // stable id for the deterministic nonce
//   sealed = seal(id, sealId, P, topic)         // ChaCha20-Poly1305, AAD = topic
//   blobId = sha256hex(sealed)                  // == server's returned id
import { sha256 } from "@noble/hashes/sha2.js";
import { File, Directory, Paths, UploadType } from "expo-file-system";
import { loadIdentity } from "./identityStore";
import { topicFor, seal, open } from "./identity";
import { getBlobServer } from "./settings";
import { NOT_PAIRED } from "./delivery";

const HEX = "0123456789abcdef";
const hex = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += HEX[x >> 4] + HEX[x & 15];
  return s;
};
const sha256hex = (b: Uint8Array): string => hex(sha256(b));

const CACHE_SUBDIR = "perun-blobs";
function cacheDir(): Directory {
  const d = new Directory(Paths.cache, CACHE_SUBDIR);
  try {
    if (!d.exists) d.create({ intermediates: true });
  } catch {
    /* best-effort — write will surface a real failure */
  }
  return d;
}

/** File extension for the decrypted cache copy, so <Image>/players sniff the type. */
function extForMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("heic")) return "heic";
  if (m.includes("gif")) return "gif";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  return "bin";
}

/** Read the raw bytes of a captured file (image-picker asset / audio recording uri). */
export async function readFileBytes(uri: string): Promise<Uint8Array> {
  return await new File(uri).bytes();
}

/**
 * Seal `bytes` with the pairing key and upload to the configured blob server.
 * Returns the blobId (= sha256 of the sealed bytes), which the annotation references.
 * Throws if unpaired, if no server is configured, or if the server's id disagrees.
 */
export async function uploadBlob(bytes: Uint8Array, mime: string): Promise<string> {
  const id = await loadIdentity();
  if (!id) throw new Error(NOT_PAIRED);
  const { url, token } = await getBlobServer();
  if (!url) throw new Error("No blob server set — add one in Pairing ▸ Attachments");

  const topic = topicFor(id);
  const sealed = seal(id, sha256hex(bytes), bytes, topic);
  const blobId = sha256hex(sealed);

  // RN fetch can't reliably send a raw binary body, so stage the sealed bytes in a
  // cache file and hand it to expo-file-system's binary upload.
  const tmp = new File(cacheDir(), `up-${blobId}.sealed`);
  try {
    if (tmp.exists) tmp.delete();
  } catch {
    /* ignore */
  }
  tmp.write(sealed);
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await tmp.upload(`${url}/blob`, {
      httpMethod: "POST",
      uploadType: UploadType.BINARY_CONTENT,
      headers,
    });
  } finally {
    try {
      tmp.delete();
    } catch {
      /* ignore */
    }
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`Blob upload failed (HTTP ${res.status})`);
  let j: { id?: string };
  try {
    j = JSON.parse(res.body);
  } catch {
    throw new Error("Blob server returned a non-JSON response");
  }
  // The server keys by sha256(body) too; a mismatch means corruption or a hostile server.
  if (j.id !== blobId) throw new Error("Blob id mismatch — refusing to trust the server's copy");
  return blobId;
}

/**
 * Fetch a sealed blob, decrypt it, and cache the plaintext locally (keyed by blobId).
 * Returns a file:// uri to render, or null if unpaired / no server / unreachable / 404
 * (callers show a placeholder — the annotation metadata still displays).
 */
export async function fetchBlob(blobId: string, mime: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(blobId)) return null;
  const out = new File(cacheDir(), `${blobId}.${extForMime(mime)}`);
  if (out.exists) return out.uri; // decrypted copy already cached

  const id = await loadIdentity();
  if (!id) return null;
  const { url } = await getBlobServer();
  if (!url) return null;
  const topic = topicFor(id);

  const sealedFile = new File(cacheDir(), `dl-${blobId}.sealed`);
  try {
    if (sealedFile.exists) sealedFile.delete();
  } catch {
    /* ignore */
  }
  try {
    // GET /blob/:id is open (the id is unguessable + the payload is ciphertext).
    await File.downloadFileAsync(`${url}/blob/${blobId}`, sealedFile, { idempotent: true });
  } catch {
    return null; // server unreachable or not found
  }
  let plain: Uint8Array;
  try {
    plain = open(id, await sealedFile.bytes(), topic);
  } catch {
    try {
      sealedFile.delete();
    } catch {
      /* ignore */
    }
    return null; // wrong key / tampered
  }
  try {
    sealedFile.delete();
  } catch {
    /* ignore */
  }
  try {
    out.write(plain);
  } catch {
    return null;
  }
  return out.uri;
}
