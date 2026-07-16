#!/usr/bin/env python3
"""HTTPS static server for the LAN module repo.

Basecamp requires https:// for a repository URL (hardcoded isHttpsUrl() in
logos-package-downloader), so the plain-http server on :8090 can't serve the
repo. This serves the same directory over TLS on :8443 using the local CA from
scripts/gen-lan-certs.sh.

:8090 stays as-is — F-Droid and the APK download are happy over http, and only
the Basecamp repo needs TLS.
"""
import http.server
import os
import ssl
import sys

ROOT = "/home/vpavlin/perun/dist/lan"
CERT = "/home/vpavlin/perun/dist/certs/server.pem"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8443


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # The index and repo card must never be cached: they carry the sha256 of
        # the current .lgx, and a stale copy makes Basecamp download bytes that
        # don't match the hash and blame the package.
        if self.path.endswith(".json"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if not os.path.exists(CERT):
    sys.exit(f"missing {CERT} — run scripts/gen-lan-certs.sh first")

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(CERT)

httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print(f"serving {ROOT} on https://0.0.0.0:{PORT}", file=sys.stderr)
httpd.serve_forever()
