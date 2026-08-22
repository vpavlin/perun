#include "perun_identity.h"

#include "pgp_words.h" // kPgpEven[256], kPgpOdd[256]

#include <openssl/core_names.h> // OSSL_KDF_PARAM_*
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/kdf.h>
#include <openssl/params.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

#include <cstring>

namespace perun {
namespace {

Bytes toBytes(const std::string &s) { return Bytes(s.begin(), s.end()); }

// HKDF-SHA256 (extract + expand), matching @noble/hashes hkdf(sha256, ikm, salt, info, len).
Bytes hkdf(const Bytes &ikm, const Bytes &saltIn, const Bytes &info, size_t len) {
  // RFC 5869: an absent/empty salt means HashLen (32) zero bytes. @noble does
  // this; OpenSSL with a zero-length salt octet-string does NOT — so normalize
  // here or Ke would diverge from the phone.
  const Bytes salt = saltIn.empty() ? Bytes(32, 0) : saltIn;

  Bytes out(len, 0);
  EVP_KDF *kdf = EVP_KDF_fetch(nullptr, "HKDF", nullptr);
  EVP_KDF_CTX *kctx = EVP_KDF_CTX_new(kdf);
  EVP_KDF_free(kdf);

  OSSL_PARAM params[5];
  int n = 0;
  char digest[] = "SHA256";
  params[n++] = OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, digest, 0);
  params[n++] = OSSL_PARAM_construct_octet_string(
      OSSL_KDF_PARAM_KEY, const_cast<uint8_t *>(ikm.data()), ikm.size());
  params[n++] = OSSL_PARAM_construct_octet_string(
      OSSL_KDF_PARAM_SALT, const_cast<uint8_t *>(salt.data()), salt.size());
  params[n++] = OSSL_PARAM_construct_octet_string(
      OSSL_KDF_PARAM_INFO, const_cast<uint8_t *>(info.data()), info.size());
  params[n] = OSSL_PARAM_construct_end();

  if (EVP_KDF_derive(kctx, out.data(), len, params) <= 0) out.clear();
  EVP_KDF_CTX_free(kctx);
  return out;
}

Bytes hmacSha256(const Bytes &key, const Bytes &msg) {
  Bytes out(32, 0);
  unsigned int l = 32;
  HMAC(EVP_sha256(), key.data(), static_cast<int>(key.size()), msg.data(), msg.size(),
       out.data(), &l);
  out.resize(l);
  return out;
}

Bytes sha256(const Bytes &msg) {
  Bytes out(SHA256_DIGEST_LENGTH, 0);
  SHA256(msg.data(), msg.size(), out.data());
  return out;
}

std::string toHex(const Bytes &b, size_t n) {
  static const char *H = "0123456789abcdef";
  std::string s;
  s.reserve(n * 2);
  for (size_t i = 0; i < n && i < b.size(); ++i) {
    s.push_back(H[b[i] >> 4]);
    s.push_back(H[b[i] & 15]);
  }
  return s;
}

// AEAD core shared by seal/open. encrypt=true seals, false opens; returns false on auth fail.
bool aead(bool encrypt, const Bytes &key, const Bytes &nonce, const Bytes &aad, const Bytes &in,
          Bytes &out, Bytes &tag) {
  EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
  bool ok = false;
  do {
    if (EVP_CipherInit_ex(c, EVP_chacha20_poly1305(), nullptr, nullptr, nullptr, encrypt) != 1) break;
    if (EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_SET_IVLEN, 12, nullptr) != 1) break;
    if (!encrypt &&
        EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_SET_TAG, 16, tag.data()) != 1)
      break;
    if (EVP_CipherInit_ex(c, nullptr, nullptr, key.data(), nonce.data(), encrypt) != 1) break;

    int l = 0;
    if (!aad.empty() && EVP_CipherUpdate(c, nullptr, &l, aad.data(), aad.size()) != 1) break;

    out.assign(in.size(), 0);
    int outl = 0;
    if (EVP_CipherUpdate(c, out.data(), &outl, in.data(), in.size()) != 1) break;
    int finl = 0;
    if (EVP_CipherFinal_ex(c, out.data() + outl, &finl) != 1) break; // decrypt: verifies tag
    out.resize(outl + finl);

    if (encrypt) {
      tag.assign(16, 0);
      if (EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_GET_TAG, 16, tag.data()) != 1) break;
    }
    ok = true;
  } while (false);
  EVP_CIPHER_CTX_free(c);
  return ok;
}

// Crockford base32 (no I, L, O, U).
const char *B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

} // namespace

Bytes randomSecret() {
  Bytes s(32, 0);
  if (RAND_bytes(s.data(), 32) != 1) s.clear();
  return s;
}

Identity deriveIdentity(const Bytes &secret) {
  Identity id;
  if (secret.size() != 32) return id;
  id.secret = secret;
  id.K = hkdf(secret, toBytes("perun-pair-v1"), {}, 32);
  id.Ke = hkdf(id.K, {}, toBytes("perun/payload/v1"), 32);
  const Bytes h = sha256(id.K);
  id.fpWords[0] = kPgpEven[h[0]];
  id.fpWords[1] = kPgpOdd[h[1]];
  id.fpWords[2] = kPgpEven[h[2]];
  id.valid = !id.K.empty() && !id.Ke.empty();
  return id;
}

std::string topicFor(const Identity &id, long epoch) {
  const Bytes t = hmacSha256(id.K, toBytes("perun/topic/v1|" + std::to_string(epoch)));
  return "/perun/1/" + toHex(t, 16) + "/proto";
}

Bytes nonceFor(const Identity &id, const std::string &sealId) {
  // loam-sync ADR 0011: deterministic id-derived AEAD nonce (domain "perun",
  // kym/qaku parity). HMAC-SHA256(Ke, "perun/nonce/v1|"+sealId), first 12 bytes.
  Bytes n = hmacSha256(id.Ke, toBytes("perun/nonce/v1|" + sealId));
  n.resize(12);
  return n;
}

Bytes seal(const Identity &id, const std::string &sealId, const Bytes &plaintext,
           const std::string &topic) {
  const Bytes nonce = nonceFor(id, sealId);
  Bytes ct, tag;
  if (!aead(true, id.Ke, nonce, toBytes(topic), plaintext, ct, tag)) return {};
  Bytes out = nonce;
  out.insert(out.end(), ct.begin(), ct.end());
  out.insert(out.end(), tag.begin(), tag.end());
  return out;
}

Bytes open(const Identity &id, const Bytes &sealed, const std::string &topic, bool *ok) {
  if (ok) *ok = false;
  if (sealed.size() < 12 + 16) return {};
  const Bytes nonce(sealed.begin(), sealed.begin() + 12);
  Bytes tag(sealed.end() - 16, sealed.end());
  const Bytes ct(sealed.begin() + 12, sealed.end() - 16);
  Bytes pt;
  if (!aead(false, id.Ke, nonce, toBytes(topic), ct, pt, tag)) return {};
  if (ok) *ok = true;
  return pt;
}

std::string encodeSecret(const Bytes &secret) {
  std::string out;
  int bits = 0, val = 0;
  for (uint8_t b : secret) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out.push_back(B32[(val >> (bits - 5)) & 31]);
      bits -= 5;
    }
  }
  if (bits > 0) out.push_back(B32[(val << (5 - bits)) & 31]);
  return out;
}

Bytes decodeSecret(const std::string &code) {
  Bytes out;
  int bits = 0, val = 0;
  for (char ch : code) {
    if (ch >= 'a' && ch <= 'z') ch -= 32; // upper
    if (ch == 'O') ch = '0';
    else if (ch == 'I' || ch == 'L') ch = '1';
    else if (ch == 'U') ch = 'V';
    const char *p = std::strchr(B32, ch);
    if (!p || ch == '\0') continue;
    val = (val << 5) | static_cast<int>(p - B32);
    bits += 5;
    if (bits >= 8) {
      out.push_back(static_cast<uint8_t>((val >> (bits - 8)) & 0xff));
      bits -= 8;
    }
  }
  if (out.size() < 32) return {};
  out.resize(32);
  return out;
}

std::string pairingUri(const Bytes &secret) { return "perun://pair?s=" + encodeSecret(secret); }

} // namespace perun

#ifdef PERUN_IDENTITY_SELFTEST
// Standalone conformance test — compile with -DPERUN_IDENTITY_SELFTEST against
// OpenSSL only (no Qt). Verifies the vectors in docs/pairing-crypto.md.
#include <cstdio>
using namespace perun;

static std::string hex(const Bytes &b) {
  std::string s;
  static const char *H = "0123456789abcdef";
  for (uint8_t x : b) { s.push_back(H[x >> 4]); s.push_back(H[x & 15]); }
  return s;
}
static Bytes unhex(const std::string &h) {
  Bytes b;
  for (size_t i = 0; i + 1 < h.size(); i += 2)
    b.push_back(static_cast<uint8_t>(std::stoi(h.substr(i, 2), nullptr, 16)));
  return b;
}

int main() {
  int fails = 0;
  auto check = [&](const char *name, bool ok) {
    std::printf("  %-22s %s\n", name, ok ? "OK" : "FAIL");
    if (!ok) fails++;
  };

  Bytes S(32);
  for (int i = 0; i < 32; i++) S[i] = i; // 0x00..0x1f
  Identity id = deriveIdentity(S);

  check("K", hex(id.K) == "919d0cbcc53ce111b35de42a62c0ff893f4dbf9757113fb95aeb5ed23dd828fb");
  check("Ke", hex(id.Ke) == "9a6571ef577ced03b33278dad61af17cc511051bb6e659238fe15b83b90be80d");
  const std::string topic = topicFor(id, 0);
  check("topic", topic == "/perun/1/022cc77b54d0977f47f4a72039ea198b/proto");
  check("fingerprint", id.fpWords[0] == kPgpEven[150] && id.fpWords[1] == kPgpOdd[142] &&
                           id.fpWords[2] == kPgpEven[189]);

  // decrypt the phone-sealed KAT wire
  const Bytes wire =
      unhex("a0a1a2a3a4a5a6a7a8a9aaab5e2b359167992fe372e07b7a8059dbf00c227e39bd8d116025");
  bool ok = false;
  Bytes pt = open(id, wire, topic, &ok);
  check("open(phone wire)", ok && std::string(pt.begin(), pt.end()) == "perun-kat");

  // our own seal must round-trip through open (deterministic id-derived nonce)
  Bytes msg = {'p', 'e', 'r', 'u', 'n', '-', 'k', 'a', 't'};
  Bytes sealed = seal(id, "test-seal", msg, topic);
  Bytes back = open(id, sealed, topic, &ok);
  check("seal->open roundtrip", ok && back == msg);

  // same id => byte-identical ciphertext (store-dedup property, ADR 0011)
  Bytes sealed2 = seal(id, "test-seal", msg, topic);
  check("seal deterministic (same id)", sealed == sealed2);
  Bytes sealedDiff = seal(id, "other-seal", msg, topic);
  check("seal differs (diff id)", sealed != sealedDiff);

  // wrong topic (AAD) must fail
  Bytes bad = open(id, wire, "/perun/1/wrong/proto", &ok);
  check("aad-bind rejects", !ok);

  // base32 code round-trip
  check("base32 roundtrip", decodeSecret(encodeSecret(S)) == S);
  std::printf("pairingUri = %s\n", pairingUri(S).c_str());

  std::printf(fails ? "\nFAILED (%d)\n" : "\nALL PASS\n", fails);
  return fails ? 1 : 0;
}
#endif
