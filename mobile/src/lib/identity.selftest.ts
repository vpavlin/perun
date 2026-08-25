// Conformance self-test for the pairing crypto (docs/pairing-crypto.md).
// Proves identity.ts reproduces the known-answer vectors the C++ module must
// match, and that seal→open round-trips. Not bundled into the app; run in dev:
//
//   node --experimental-strip-types \
//     --import ./register.mjs \   (registers a loader that shims expo-crypto
//     src/lib/identity.selftest.ts    with node:crypto + resolves ./pgpWords.ts)
//
import { deriveIdentity, topicFor, seal, open, encodeSecret, decodeSecret, secretFromScan } from "./identity";
import { PGP_EVEN, PGP_ODD } from "./pgpWords";

const HEXCH = "0123456789abcdef";
const hex = (b: Uint8Array) => { let s = ""; for (const x of b) s += HEXCH[x >> 4] + HEXCH[x & 15]; return s; };
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

let failed = 0;
const check = (name: string, ok: boolean, got?: unknown, want?: unknown) => {
  if (ok) { console.log("  ok   " + name); }
  else { failed++; console.log(`  FAIL ${name}\n       got=${String(got)}\n       want=${String(want)}`); }
};

// KAT secret S = 0x00,0x01,…,0x1f
const S = new Uint8Array(32).map((_, i) => i);
const id = deriveIdentity(S);

check("K", hex(id.K) === "919d0cbcc53ce111b35de42a62c0ff893f4dbf9757113fb95aeb5ed23dd828fb", hex(id.K));
check("Ke", hex(id.Ke) === "9a6571ef577ced03b33278dad61af17cc511051bb6e659238fe15b83b90be80d", hex(id.Ke));

const topic = topicFor(id, 0);
check("topic", topic === "/perun/1/022cc77b54d0977f47f4a72039ea198b/proto", topic);

check("fingerprint", JSON.stringify(id.fingerprint) === JSON.stringify([PGP_EVEN[150], PGP_ODD[142], PGP_EVEN[189]]),
  id.fingerprint.join(" "), [PGP_EVEN[150], PGP_ODD[142], PGP_EVEN[189]].join(" "));

// SEAL/OPEN cross-impl vector: open the fixed module-side wire → "perun-kat".
const wire = unhex("a0a1a2a3a4a5a6a7a8a9aaab5e2b359167992fe372e07b7a8059dbf00c227e39bd8d116025");
check("open(KAT wire)", new TextDecoder().decode(open(id, wire, topic)) === "perun-kat");

// seal→open round-trips (deterministic id-derived nonce path, ADR 0011).
const msg = ascii("hello perun");
check("seal→open round-trip", new TextDecoder().decode(open(id, seal(id, "test-seal", msg, topic), topic)) === "hello perun");

// same id => byte-identical ciphertext (store-dedup property); diff id => differs.
check("seal deterministic (same id)", hex(seal(id, "test-seal", msg, topic)) === hex(seal(id, "test-seal", msg, topic)));
check("seal differs (diff id)", hex(seal(id, "test-seal", msg, topic)) !== hex(seal(id, "other-seal", msg, topic)));

// Pairing code round-trip + lenient scan parsing.
check("encode/decode secret", hex(decodeSecret(encodeSecret(S))) === hex(S));
check("secretFromScan(uri)", hex(secretFromScan(`perun://pair?s=${encodeSecret(S)}`)) === hex(S));

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
