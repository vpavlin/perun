# Perun pairing + payload crypto (v1)

Both ends (phone `src/lib/identity.ts`, module `src/perun_identity.*`) MUST implement
these derivations identically. The known-answer vector below is the conformance test.

## Secret
`S` = 32 random bytes, created on one device, carried to the other out-of-band via a
QR / `perun://pair?s=<crockford-base32(S)>` link. 256 bits because the derived topic is
public on the wire and thus offline-brute-forceable from S.

## Derivations
```
K            = HKDF-SHA256(ikm=S, salt="perun-pair-v1", info="",                 L=32)
Ke           = HKDF-SHA256(ikm=K, salt="",              info="perun/payload/v1", L=32)
topic(e)     = HMAC-SHA256(K, "perun/topic/v1|" + decimal(e))[0..15]      # 16 bytes
contentTopic = "/perun/1/" + lower_hex(topic(e)) + "/proto"
fingerprint  = [ PGP_EVEN[H[0]], PGP_ODD[H[1]], PGP_EVEN[H[2]] ],  H = SHA-256(K)
```
- Epoch `e`: phase 1 uses `e=0` (static). Phase 2: `e = floor(unixDays/7)`, phone publishes
  on `e`, desktop subscribes to `{e-1, e, e+1}`. Wire format unchanged.
- `/perun/1/` prefix is FIXED so autosharding (which hashes only app+version, not the
  topic name) keeps every Perun user on the same shard the desktop already subscribes to.

## Payload encryption
```
wire = nonce(12 random bytes) || ChaCha20-Poly1305(key=Ke, nonce, plaintext, aad=contentTopic)
```
- ChaCha20-Poly1305 IETF (96-bit nonce), NOT XChaCha — OpenSSL (module side) has the former.
- AAD = the exact contentTopic string → a message can't be replayed onto another topic.
- `plaintext` is the existing CHUNK/META/DELETE envelope bytes (see wire-contract.md v3).
  Encryption wraps the payload; the topic itself already hides identity.

## Pairing code
Crockford base32 of S (52 chars). Parse leniently: case-insensitive, strip non-alphanumerics,
map O→0, I/L→1, U→V. Confirm by both ends displaying the same 3-word fingerprint.

## KNOWN-ANSWER VECTOR (conformance)
Input secret S = bytes 0x00,0x01,0x02,…,0x1f (i.e. S[i] = i):
```
contentTopic (e=0) = /perun/1/022cc77b54d0977f47f4a72039ea198b/proto
fingerprint indices = 150, 142, 189   (PGP_EVEN[150], PGP_ODD[142], PGP_EVEN[189])
```
The phone (identity.ts) produces exactly this. The C++ module implementation is correct
iff it reproduces the same topic hex and the same three indices for this S.

## SEAL/OPEN cross-impl vector (module OpenSSL must decrypt this phone output)
Same S (bytes 0x00..0x1f), epoch 0. Fixed nonce for the KAT (real code uses random):
```
K     = 919d0cbcc53ce111b35de42a62c0ff893f4dbf9757113fb95aeb5ed23dd828fb
Ke    = 9a6571ef577ced03b33278dad61af17cc511051bb6e659238fe15b83b90be80d
topic = /perun/1/022cc77b54d0977f47f4a72039ea198b/proto
nonce = a0a1a2a3a4a5a6a7a8a9aaab
aad   = topic (the exact string above)
wire  = a0a1a2a3a4a5a6a7a8a9aaab5e2b359167992fe372e07b7a8059dbf00c227e39bd8d116025
        (= 12-byte nonce ‖ ChaCha20-Poly1305 ciphertext ‖ 16-byte tag, total 37 bytes)
plaintext = "perun-kat"
```
The module is correct iff `open(Ke, wire, aad=topic)` == "perun-kat", and iff sealing
"perun-kat" with this Ke+nonce+aad reproduces `wire` byte-for-byte.

## Word list
256 even + 256 odd, Juola/Zimmermann PGP biometric words. Canonical source:
`receiver-basecamp/src/pgp_words.h`, vendored to BOTH `module/src/pgp_words.h` (kPgpEven/kPgpOdd)
and generated into `mobile/src/lib/pgpWords.ts` (PGP_EVEN/PGP_ODD). even[0]=aardvark,
odd[0]=adroitness, even[255]=Zulu, odd[255]=Yucatan.
