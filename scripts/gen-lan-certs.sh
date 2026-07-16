#!/usr/bin/env bash
# Create a local CA + a TLS cert for this LAN box, so Basecamp will accept the
# module repository served here.
#
# WHY THIS IS NEEDED (verified in logos-package-downloader/src/
# package_downloader_lib.cpp):
#
#     bool isHttpsUrl(const std::string& url) {
#         return url.rfind("https://", 0) == 0;
#     }
#     ... if (!isHttpsUrl(url)) return "unsupported URL scheme (https required in v1)";
#
# It is a hardcoded prefix check with NO bypass, no localhost exemption, and it
# runs both in addRepository() and refreshOne() — so writing the config file by
# hand doesn't dodge it either. "v1" is the repository-registry feature version,
# NOT index.json's schemaVersion.
#
# WHY A SELF-SIGNED CA IS ENOUGH: the downloader is libcurl, and its
# applyCaBundle() honours CURL_CA_BUNDLE / SSL_CERT_FILE / NIX_SSL_CERT_FILE /
# SSL_CERT_DIR *before* probing system locations. So the laptop can trust this CA
# via one env var — no root, no system trust store surgery.
set -euo pipefail

CERT_DIR=/home/vpavlin/perun/dist/certs
HOST="${1:-$(hostname -I | awk '{print $1}')}"
DAYS=3650

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

if [ ! -f ca.key ]; then
  echo "creating local CA…"
  openssl genrsa -out ca.key 4096 2>/dev/null
  openssl req -x509 -new -nodes -key ca.key -sha256 -days $DAYS -out ca.pem \
    -subj "/C=CZ/O=Perun LAN/CN=Perun LAN Root CA" 2>/dev/null
fi

# The cert must carry an IP SAN. curl verifies the SAN, and a CN-only cert is
# rejected outright by modern OpenSSL — a CN of "192.168.0.152" is NOT enough.
cat > san.cnf <<EOF
[req]
distinguished_name = dn
req_extensions = ext
prompt = no
[dn]
C  = CZ
O  = Perun LAN
CN = ${HOST}
[ext]
subjectAltName = @alt
[alt]
IP.1  = ${HOST}
DNS.1 = localhost
IP.2  = 127.0.0.1
EOF

echo "issuing server cert for ${HOST}…"
openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -key server.key -out server.csr -config san.cnf 2>/dev/null
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out server.crt -days $DAYS -sha256 \
  -extfile san.cnf -extensions ext 2>/dev/null
cat server.crt server.key > server.pem
chmod 600 server.key server.pem

# Bundle = system CAs + our CA. Must include the system roots, or pointing
# SSL_CERT_FILE at this file would break the DEFAULT (github) repository, which
# Basecamp also fetches over TLS.
SYS_CA=""
for p in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
  [ -f "$p" ] && { SYS_CA="$p"; break; }
done
[ -n "$SYS_CA" ] && cat "$SYS_CA" ca.pem > perun-ca-bundle.pem || cp ca.pem perun-ca-bundle.pem
chmod 644 perun-ca-bundle.pem ca.pem

echo
echo "CA:        $CERT_DIR/ca.pem"
echo "server:    $CERT_DIR/server.pem   (cert+key, for the https server)"
echo "bundle:    $CERT_DIR/perun-ca-bundle.pem   (system CAs + ours — copy to the laptop)"
echo
openssl x509 -in server.crt -noout -text | grep -A1 "Subject Alternative Name"
