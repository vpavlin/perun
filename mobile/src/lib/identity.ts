// Perun pairing identity + payload crypto (phone side).
//
// One symmetric 32-byte pre-shared secret S pairs a phone with its desktop
// Basecamp module. Everything is derived from S — no elliptic curve, no key
// exchange, no server. S is created on ONE device and carried to the other
// out-of-band (a QR the desktop shows, or a perun://pair link), then confirmed
// by both ends showing the same 3-word fingerprint.
//
// Derivations (must match the C++ module byte-for-byte):
//   K            = HKDF-SHA256(ikm=S, salt="perun-pair-v1", info="", 32)
//   topic(e)     = HMAC-SHA256(K, "perun/topic/v1|"+e)[0..15]  (16 bytes)
//   contentTopic = "/perun/1/" + hex(topic(e)) + "/proto"
//   Ke           = HKDF-SHA256(ikm=K, salt="",  info="perun/payload/v1", 32)
//   fingerprint  = pgpWords(SHA-256(K)[0..2])   (even/odd/even)
//   wire payload = nonce(12) || ChaCha20-Poly1305(Ke, nonce, plaintext, aad=contentTopic)
//
// The derived topic is public on the wire, so it is offline-brute-forceable
// from S — which is why S must be full-entropy (32 bytes), never a short code.
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import * as Crypto from "expo-crypto";
import { PGP_EVEN, PGP_ODD } from "./pgpWords";

const enc = (s: string) => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
};

const SALT_PAIR = enc("perun-pair-v1");
const INFO_PAYLOAD = enc("perun/payload/v1");
const HEX = "0123456789abcdef";
const hex = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += HEX[x >> 4] + HEX[x & 15];
  return s;
};

/** A paired identity: the raw secret plus everything derived from it. */
export interface Identity {
  secret: Uint8Array; // S, 32 bytes
  K: Uint8Array; // master derived key
  Ke: Uint8Array; // payload encryption key
  fingerprint: string[]; // 3 pgp words, shown on both ends to confirm
}

/** Fresh 32-byte secret from the platform CSPRNG (Android SecureRandom). */
export function newSecret(): Uint8Array {
  return Crypto.getRandomBytes(32);
}

/** Derive the full identity from a 32-byte secret. Pure; no I/O. */
export function deriveIdentity(secret: Uint8Array): Identity {
  if (secret.length !== 32) throw new Error("perun secret must be 32 bytes");
  const K = hkdf(sha256, secret, SALT_PAIR, new Uint8Array(0), 32);
  const Ke = hkdf(sha256, K, new Uint8Array(0), INFO_PAYLOAD, 32);
  const fp = sha256(K).slice(0, 3);
  const fingerprint = [PGP_EVEN[fp[0]], PGP_ODD[fp[1]], PGP_EVEN[fp[2]]];
  return { secret, K, Ke, fingerprint };
}

/** The content topic for a given rotation epoch (default 0 = static, phase 1). */
export function topicFor(id: Identity, epoch = 0): string {
  const t = hmac(sha256, id.K, enc(`perun/topic/v1|${epoch}`)).slice(0, 16);
  return `/perun/1/${hex(t)}/proto`;
}

/** Encrypt plaintext bytes → nonce(12) ‖ ciphertext‖tag, AAD-bound to the topic. */
export function seal(id: Identity, plaintext: Uint8Array, topic: string): Uint8Array {
  const nonce = Crypto.getRandomBytes(12);
  const ct = chacha20poly1305(id.Ke, nonce, enc(topic)).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/** Inverse of seal(). Throws if the tag doesn't verify (tamper/wrong key). */
export function open(id: Identity, sealed: Uint8Array, topic: string): Uint8Array {
  const nonce = sealed.subarray(0, 12);
  const ct = sealed.subarray(12);
  return chacha20poly1305(id.Ke, nonce, enc(topic)).decrypt(ct);
}

// ---- Pairing code <-> secret (Crockford base32, no I/O) --------------------
// 32 bytes = 256 bits = 52 base32 chars. Shown grouped; parsing is lenient
// (case-insensitive, ignores separators, maps the usual look-alikes).
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford (no I,L,O,U)

export function encodeSecret(secret: Uint8Array): string {
  let bits = 0, val = 0, out = "";
  for (const b of secret) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

export function decodeSecret(code: string): Uint8Array {
  const clean = code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length < 32) throw new Error("pairing code too short");
  return new Uint8Array(out.slice(0, 32));
}

/** The deep link a QR / camera-app scan yields: perun://pair?s=<base32>. */
export function pairingUri(secret: Uint8Array): string {
  return `perun://pair?s=${encodeSecret(secret)}`;
}

/** Extract the secret from a scanned string: a perun://pair?s=… link or a bare code. */
export function secretFromScan(text: string): Uint8Array {
  const m = text.match(/[?&]s=([^&\s]+)/);
  return decodeSecret(m ? decodeURIComponent(m[1]) : text);
}
