#pragma once
// Perun pairing identity + payload crypto (Basecamp module side).
//
// Mirror of the phone's mobile/src/lib/identity.ts — the two MUST derive
// identical values. Conformance vectors live in docs/pairing-crypto.md; the
// self-test at the bottom of perun_identity.cpp checks them.
//
// std types only (no Qt) so this compiles + tests against OpenSSL alone. The
// backend converts to/from QByteArray at the boundary.
#include <cstdint>
#include <string>
#include <vector>

namespace perun {

using Bytes = std::vector<uint8_t>;

// A 32-byte pre-shared secret S plus everything derived from it.
struct Identity {
  Bytes secret;          // S, 32 bytes
  Bytes K;               // master key = HKDF(S, salt="perun-pair-v1")
  Bytes Ke;              // payload key = HKDF(K, info="perun/payload/v1")
  std::string fpWords[3]; // 3-word pairing fingerprint (shown on both ends)
  bool valid = false;
};

// Fresh 32-byte secret from OpenSSL RAND_bytes.
Bytes randomSecret();

// Derive the full identity from a 32-byte secret (invalid if size != 32).
Identity deriveIdentity(const Bytes &secret);

// Content topic for a rotation epoch (default 0 = static, phase 1).
//   "/perun/1/" + hex(HMAC-SHA256(K, "perun/topic/v1|"+epoch)[0..15]) + "/proto"
std::string topicFor(const Identity &id, long epoch = 0);

// Encrypt: nonce(12) || ChaCha20-Poly1305(Ke, nonce, plaintext, aad=topic).
Bytes seal(const Identity &id, const Bytes &plaintext, const std::string &topic);

// Decrypt seal() output. On auth failure returns empty and *ok=false.
Bytes open(const Identity &id, const Bytes &sealed, const std::string &topic, bool *ok = nullptr);

// Crockford base32 of S, for the pairing QR (perun://pair?s=<code>).
std::string encodeSecret(const Bytes &secret);
// Lenient parse of a pairing code back to S (empty if < 32 bytes decoded).
Bytes decodeSecret(const std::string &code);
// The full deep link the module encodes into its pairing QR.
std::string pairingUri(const Bytes &secret);

} // namespace perun
