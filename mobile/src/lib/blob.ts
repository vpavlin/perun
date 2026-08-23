// Local-first, content-addressed attachment store for journey annotations
// (photos / voice notes). LOCAL-FIRST: the media is the user's, so it is stored
// on THIS device first and always — capturing a note never depends on a server or
// even on being paired. A server (today a small HTTP blob server; tomorrow a Logos
// Storage node — see BlobBackend) is only a best-effort REPLICATION target so other
// devices in the household can fetch what they don't have. It is never the source of
// truth and never on the capture path.
//
// Content addressing (the "CID" an annotation event links to):
//   sealId = sha256hex(plaintext)               // stable id → deterministic nonce
//   sealed = seal(id, sealId, plaintext, topic) // ChaCha20-Poly1305, AAD = topic
//   cid    = sha256hex(sealed)                  // == the wire `blobId`
// We hash the SEALED bytes, not the plaintext: that keeps the store zero-trust (it
// only ever holds ciphertext) while STILL deduplicating (the seal is deterministic,
// so the same file always yields the same sealed bytes → the same cid). Hashing the
// plaintext would leak content-equality to the store and break zero-trust.
//
// On disk we keep the PLAINTEXT (this is the owner's device) keyed by cid, so
// rendering is instant with no per-view decrypt. Replication re-seals on demand
// (deterministic → identical bytes → identical cid), so we never persist ciphertext.
import { sha256 } from "@noble/hashes/sha2.js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { File, Directory, Paths, UploadType } from "expo-file-system";
import { loadIdentity, ensureIdentity } from "./identityStore";
import { topicFor, seal, open, Identity } from "./identity";
import { getBlobServer } from "./settings";

const HEX = "0123456789abcdef";
const hex = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += HEX[x >> 4] + HEX[x & 15];
  return s;
};
const sha256hex = (b: Uint8Array): string => hex(sha256(b));
const isCid = (cid: string) => /^[0-9a-f]{64}$/.test(cid);

// ---- durable local store (document dir — survives cache eviction) -----------
const STORE_SUBDIR = "perun-blobs";
function storeDir(): Directory {
  const d = new Directory(Paths.document, STORE_SUBDIR);
  try {
    if (!d.exists) d.create({ intermediates: true });
  } catch {
    /* best-effort — a write will surface a real failure */
  }
  return d;
}

/** File extension for the local plaintext copy, so <Image>/players sniff the type. */
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

function localFile(cid: string, mime: string): File {
  return new File(storeDir(), `${cid}.${extForMime(mime)}`);
}

/** Read the raw bytes of a captured file (image-picker asset / audio recording uri). */
export async function readFileBytes(uri: string): Promise<Uint8Array> {
  return await new File(uri).bytes();
}

function sealBytes(id: Identity, bytes: Uint8Array): { sealed: Uint8Array; cid: string } {
  const topic = topicFor(id);
  const sealed = seal(id, sha256hex(bytes), bytes, topic);
  return { sealed, cid: sha256hex(sealed) };
}

/**
 * Store captured media on THIS device and return its content id (cid == wire blobId).
 * Never touches the network. Provisions a household key on first use so the cid is
 * well-defined even for a brand-new, unpaired install (see ensureIdentity). Fire
 * replicateBlob(cid, mime) afterwards to best-effort push a sealed copy to the server.
 */
export async function saveLocalBlob(bytes: Uint8Array, mime: string): Promise<string> {
  const id = await ensureIdentity();
  const { cid } = sealBytes(id, bytes);
  const out = localFile(cid, mime);
  if (!out.exists) out.write(bytes); // plaintext — the owner's own device
  return cid;
}

/** file:// uri for a locally-held blob, or null if we don't have it on this device. */
export function localBlobUri(cid: string, mime: string): string | null {
  if (!isCid(cid)) return null;
  try {
    const f = localFile(cid, mime);
    return f.exists ? f.uri : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a blob to a renderable file:// uri, LOCAL-FIRST. If we don't have it (an
 * annotation authored on another device), fall back to the configured backend: fetch
 * the sealed bytes, decrypt, and cache the plaintext locally so it's instant next time.
 * Returns null if we don't have it and can't fetch it (no key / no server / unreachable /
 * wrong key) — callers show a placeholder; the annotation metadata still displays.
 */
export async function resolveBlobUri(cid: string, mime: string): Promise<string | null> {
  const local = localBlobUri(cid, mime);
  if (local) return local;
  if (!isCid(cid)) return null;

  const id = await loadIdentity();
  if (!id) return null;
  const backend = await getBackend();
  if (!backend) return null;

  const sealed = await backend.get(cid);
  if (!sealed) return null;
  let plain: Uint8Array;
  try {
    plain = open(id, sealed, topicFor(id));
  } catch {
    return null; // wrong key / tampered
  }
  try {
    const out = localFile(cid, mime);
    out.write(plain);
    void markSynced(cid); // we and the server both have it now
    return out.uri;
  } catch {
    return null;
  }
}

// ---- replication (best-effort push to the backend) --------------------------
const SYNCED_KEY = "perun:blobsynced"; // JSON array of cids known to be on the backend

async function readSynced(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(SYNCED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
async function markSynced(cid: string): Promise<void> {
  try {
    const set = await readSynced();
    if (set.has(cid)) return;
    set.add(cid);
    await AsyncStorage.setItem(SYNCED_KEY, JSON.stringify([...set]));
  } catch {
    /* best-effort */
  }
}

/**
 * Best-effort: seal the locally-held blob and push it to the backend so other devices
 * can fetch it. Never throws. Returns true if the blob is confirmed on the backend
 * (freshly uploaded or already marked), false if there's no backend / we lack the bytes
 * / the upload failed (it'll be retried by replicatePending).
 */
export async function replicateBlob(cid: string, mime: string): Promise<boolean> {
  if (!isCid(cid)) return false;
  if ((await readSynced()).has(cid)) return true;
  const backend = await getBackend();
  if (!backend) return false;
  const id = await loadIdentity();
  if (!id) return false;
  let bytes: Uint8Array;
  try {
    const f = localFile(cid, mime);
    if (!f.exists) return false;
    bytes = await f.bytes();
  } catch {
    return false;
  }
  const { sealed, cid: check } = sealBytes(id, bytes);
  if (check !== cid) return false; // key changed since capture — can't reproduce this cid
  try {
    await backend.put(cid, sealed);
    await markSynced(cid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retry replication for every locally-held blob not yet confirmed on the backend.
 * Called when the network/receiver comes up (alongside annotations.resendUnsynced).
 * Walks the store dir; the file extension carries the mime well enough to re-seal.
 */
export async function replicatePending(): Promise<void> {
  if (!(await getBackend())) return;
  const synced = await readSynced();
  let names: string[] = [];
  try {
    names = storeDir().list().map((e) => (e instanceof File ? e.name : "")).filter(Boolean);
  } catch {
    return;
  }
  for (const name of names) {
    const dot = name.lastIndexOf(".");
    const cid = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot + 1) : "bin";
    if (!isCid(cid) || synced.has(cid)) continue;
    const ok = await replicateBlob(cid, ext); // ext round-trips through extForMime
    if (!ok) break; // backend down — stop; try again next time
  }
}

// ---- backend (swappable: HTTP server today, Logos Storage node tomorrow) ----
// The annotation/CRDT layer only ever sees put(cid)/get(cid); swapping the backing
// store (e.g. to a Logos Storage node) is entirely below this seam.
export interface BlobBackend {
  put(cid: string, sealed: Uint8Array): Promise<void>; // throws on failure
  get(cid: string): Promise<Uint8Array | null>; // null if absent/unreachable
}

/** The configured backend, or null if none is set (capture still works — local-only). */
async function getBackend(): Promise<BlobBackend | null> {
  const { url, token } = await getBlobServer();
  if (!url) return null;
  return new HttpBlobBackend(url, token);
}

const CACHE_SUBDIR = "perun-blob-tmp";
function tmpDir(): Directory {
  const d = new Directory(Paths.cache, CACHE_SUBDIR);
  try {
    if (!d.exists) d.create({ intermediates: true });
  } catch {
    /* ignore */
  }
  return d;
}

/** The current custom HTTP blob server (perun/server/server.mjs). Content-addressed:
 *  POST /blob returns {id: sha256(body)}; GET /blob/:id serves the sealed bytes. */
class HttpBlobBackend implements BlobBackend {
  constructor(private url: string, private token: string) {}

  async put(cid: string, sealed: Uint8Array): Promise<void> {
    // RN fetch can't reliably send a raw binary body, so stage the sealed bytes and
    // hand the file to expo-file-system's binary upload.
    const tmp = new File(tmpDir(), `up-${cid}.sealed`);
    try {
      if (tmp.exists) tmp.delete();
    } catch {
      /* ignore */
    }
    tmp.write(sealed);
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await tmp.upload(`${this.url}/blob`, {
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
    if (j.id !== cid) throw new Error("Blob id mismatch — refusing to trust the server's copy");
  }

  async get(cid: string): Promise<Uint8Array | null> {
    const dl = new File(tmpDir(), `dl-${cid}.sealed`);
    try {
      if (dl.exists) dl.delete();
    } catch {
      /* ignore */
    }
    try {
      // GET /blob/:id is open (the id is unguessable + the payload is ciphertext).
      await File.downloadFileAsync(`${this.url}/blob/${cid}`, dl, { idempotent: true });
      const bytes = await dl.bytes();
      return bytes;
    } catch {
      return null; // unreachable or 404
    } finally {
      try {
        dl.delete();
      } catch {
        /* ignore */
      }
    }
  }
}
