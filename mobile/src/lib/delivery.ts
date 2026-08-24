// Perun's thin adapter over the SHARED loam-transport (mobile/src/lib/loam-transport.ts).
//
// Perun used to drive its OWN embedded liblogosdelivery node via the LogosMessaging
// JNI module directly. This routes the SAME sealed-bytes wire through loam-transport
// instead, which can run either the app's embedded node (RealNode) or the device-wide
// Logos Delivery SERVICE (ServiceNode) — toggled per user via preferServiceBackend.
// The wire is unchanged: one derived content topic per pairing, and the whole
// envelope-JSON sealed (ChaCha20-Poly1305, AAD=topic) with the pairing key. So this
// swap keeps Perun's proven mobile→Basecamp delivery; it only changes WHICH node
// carries the bytes. App-specific pieces kept here: the single pair route, the
// seal/open crypto (identity.ts), and envelope (JSON blob) framing.
import { loadIdentity } from "./identityStore";
import { seal, open, topicFor, Identity } from "./identity";
import * as transport from "./loam-transport";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

const HEX = "0123456789abcdef";
const hex = (b: Uint8Array) => { let s = ""; for (const x of b) s += HEX[x >> 4] + HEX[x & 15]; return s; };

// Documentation of the topic *shape*; live sends use topicFor(id).
export const PERUN_TOPIC = "/perun/1/<derived-from-pairing-secret>/proto";

/** Error thrown when a sync is attempted before pairing. Surfaced to the user. */
export const NOT_PAIRED = "Pair with your Basecamp first";

/** True if a Logos Delivery backend (embedded node or shared service) is present. */
export function deliveryAvailable(): boolean {
  return transport.deliveryAvailable();
}

/**
 * The 3-word pairing fingerprint of the household this phone currently seals with
 * (null if unpaired). Surfaced during sync so a household-KEY MISMATCH — phone and
 * desktop on different secrets, the classic silent "connected but no sync" — is
 * visible at a glance instead of guessed from matching-looking words.
 */
export function currentFingerprint(): string | null {
  return route ? route.id.fingerprint.join(" ") : null;
}

// The single pair route: the phone↔Basecamp pairing identity + its derived topic.
// An unpaired phone has no route and MUST NOT publish — never a public plaintext topic.
let route: { id: Identity; topic: string } | null = null;

// Receive listeners (two-way is future; publishing does not require any). adapterReceive
// opens each candidate with the pairing key and forwards the decoded envelope.
type MsgCb = (env: unknown) => void;
let listeners: MsgCb[] = [];

// A stable per-install device id used as the SDS senderId. Generated once, persisted.
// Also serves as an annotation's `author` (a device/addr string, per the wire contract).
export async function getDeviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync("perun-device-id");
  if (!id) {
    id = "perun-" + Math.random().toString(16).slice(2) + Date.now().toString(36);
    await SecureStore.setItemAsync("perun-device-id", id);
  }
  return id;
}

// UTF-8 encode a string to bytes. Hand-rolled on purpose: no TextEncoder (not
// guaranteed on Hermes) and no escape/unescape (legacy Annex-B globals).
function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

// UTF-8 decode bytes to a string. Hand-rolled to match utf8Bytes (no TextDecoder).
function utf8Decode(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c < 0xe0) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    } else if (c < 0xf0) {
      out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
    } else {
      const cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
      const u = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
    }
  }
  return out;
}

// Transport hands us the candidate sealed-byte arrays for a content topic; open with
// the pairing key and forward the decoded envelope. Return true iff a candidate opened
// (so the transport tallies rxOpened vs rxOpenFail). open() is authenticated — only the
// right key/candidate wins.
function adapterReceive(topic: string, candidates: Uint8Array[]): boolean {
  if (!route) return false;
  for (const cand of candidates) {
    let plaintext: Uint8Array;
    try {
      plaintext = open(route.id, cand, route.topic);
    } catch {
      continue; // wrong key/candidate
    }
    try {
      const env = JSON.parse(utf8Decode(plaintext));
      listeners.forEach((cb) => cb(env));
    } catch {
      /* opened but not a valid envelope */
    }
    return true;
  }
  return false;
}

/**
 * Bring the node up once (idempotent): load identity (must be paired) → start the
 * shared transport on the pair's derived topic. Concurrent callers share the
 * transport's in-flight startup. Rejects with NOT_PAIRED if the phone isn't paired.
 * Routes through the device-wide Logos Delivery service when the user enabled it
 * ("perun-shared-node"), else the app embeds its own node. Returns the node ctx.
 */
export async function ensureNode(onStatus?: (s: string) => void): Promise<string> {
  if (!transport.deliveryAvailable()) throw new Error("Logos Delivery native module not present in this build");
  if (transport.getCtx()) return transport.getCtx(); // already up
  const id = await loadIdentity();
  if (!id) throw new Error(NOT_PAIRED);
  route = { id, topic: topicFor(id) };
  const deviceId = await getDeviceId();
  // Must be set BEFORE the first transport call.
  try {
    const shared = (await SecureStore.getItemAsync("perun-shared-node")) === "1";
    (transport as { preferServiceBackend?: (on: boolean, appId: string) => void }).preferServiceBackend?.(shared, "perun");
  } catch {
    /* default to embedded */
  }
  await transport.start({ deviceId, topics: [route.topic], onStatus, onReceive: adapterReceive });
  return transport.getCtx();
}

/**
 * Publish one JSON envelope on the pair's derived topic. The whole envelope-JSON is
 * sealed (ChaCha20-Poly1305, AAD=topic) with the pairing key; the transport does the
 * channel framing. No pairing → no send: we never publish plaintext on a public topic.
 */
export async function sendEnvelope(env: object): Promise<void> {
  await ensureNode();
  const r = route!;
  const sealed = seal(r.id, sealIdFor(env), utf8Bytes(JSON.stringify(env)), r.topic);
  await transport.publishSealed(r.topic, sealed);
}

// The stable seal id feeding the deterministic nonce (ADR 0011). A CHUNK is
// immutable and uniquely identified by run+rev+seq, so re-sending it re-seals
// byte-identical → the fleet store dedups it. Any other (control) frame gets a
// fresh random id so distinct control frames are never collapsed together.
function sealIdFor(env: object): string {
  const e = env as { type?: unknown; id?: unknown; rev?: unknown; seq?: unknown; a?: { id?: unknown } };
  if (e.type === "CHUNK" && e.id != null && e.rev != null && e.seq != null) {
    return `${e.id}|${e.rev}|${e.seq}`;
  }
  // An ANNOTATION is immutable and uniquely identified by a.id — seal it deterministically
  // too, so a re-send is byte-identical and the fleet store dedups it (matches CHUNK).
  if (e.type === "ANNOTATION" && e.a && e.a.id != null) {
    return `ann|${e.a.id}`;
  }
  return hex(Crypto.getRandomBytes(12));
}

/** Subscribe to incoming Delivery messages (returns an unsubscribe fn). */
export function onMessage(cb: (env: unknown) => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((x) => x !== cb);
  };
}

/** Stop the node (best-effort). */
export async function stopNode(): Promise<void> {
  route = null;
  try {
    await transport.stop();
  } catch {
    /* ignore */
  }
}
