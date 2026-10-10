#!/usr/bin/env python3
"""Tiny static file server for the WiiCompiled web build (Python 3 standard library only).

    python3 web/serve.py [--dir web/dist] [--bind 127.0.0.1] [--port 8080]
    python3 web/serve.py --https --lan        # let other devices on your network play

Why not `python -m http.server`: the game streams the extracted disc tree with HTTP Range
requests, and `http.server` ignores Range. This server supports single ranges (`bytes=a-b`,
`bytes=a-`, `bytes=-n`), answers 206 with Content-Range (416 when unsatisfiable) and serves
`.wasm` as application/wasm.

Caching and compression (see docs/web-hosting.md):
  * `X.<sha8>.wasm` (content-hashed by web/tools/precompress_dist.py) is sent with
    `Cache-Control: public, max-age=31536000, immutable`; html/js/json/other wasm use `no-cache`.
  * If `F.br` or `F.gz` sits next to a file `F` and the client accepts that encoding and sent no
    Range header, the precompressed file is sent with `Content-Encoding` and `Vary: Accept-Encoding`
    (br preferred). Range requests always get the uncompressed file.

127.0.0.1 counts as a secure context, which WebGPU requires; other devices need HTTPS. `--https`
serves TLS with a self-signed certificate that is generated on first use (web/selfsigned_cert.py) and
cached in web/.certs/, valid for localhost, 127.0.0.1 and this machine's host name and LAN IPs;
`--cert/--key` use your own. The default bind address stays 127.0.0.1; `--lan` (= `--bind 0.0.0.0`)
makes the server reachable from the network.
"""

import argparse
import email.utils
import mimetypes
import os
import re
import socket
import ssl
import sys
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CHUNK = 1 << 20

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json",
    ".gz": "application/gzip",
    ".br": "application/octet-stream",
}
NO_CACHE_EXTENSIONS = {".html", ".htm", ".js", ".mjs", ".wasm", ".json"}
# Content-hashed build outputs (web/tools/precompress_dist.py): the name changes with the content.
IMMUTABLE_RE = re.compile(r"\.[0-9a-f]{8}\.wasm(\.gz|\.br)?$")
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
# Precompressed siblings, in order of preference: Content-Encoding token -> file suffix.
PRECOMPRESSED = (("br", ".br"), ("gzip", ".gz"))
HANDSHAKE_TIMEOUT = 15

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def guess_type(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in MIME_TYPES:
        return MIME_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


class RangeError(Exception):
    """The Range header is syntactically valid but cannot be satisfied."""


def parse_range(header, size):
    """Parse a Range header against a resource of `size` bytes.

    Returns None if the header should be ignored (absent, not `bytes`, multiple ranges,
    or malformed: the server then answers 200 with the full body, as RFC 9110 allows),
    or an inclusive (start, end) tuple. Raises RangeError if unsatisfiable (-> 416).
    """
    if not header:
        return None
    header = header.strip()
    if "," in header:
        return None  # multiple ranges: not supported, serve the whole representation
    m = _RANGE_RE.match(header)
    if not m:
        return None
    first, last = m.group(1), m.group(2)
    if not first and not last:
        return None
    if not first:  # suffix: last N bytes
        n = int(last)
        if n == 0 or size == 0:
            raise RangeError
        return max(size - n, 0), size - 1
    start = int(first)
    if start >= size:
        raise RangeError
    if not last:
        return start, size - 1
    end = int(last)
    if end < start:
        return None  # invalid per RFC: ignore the header
    return start, min(end, size - 1)


def accepted_encodings(header):
    """Parse Accept-Encoding into {coding: q}; '*' is kept as a key."""
    result = {}
    for item in (header or "").split(","):
        token, _, params = item.partition(";")
        token = token.strip().lower()
        if not token:
            continue
        q = 1.0
        m = re.search(r"q\s*=\s*([0-9.]+)", params)
        if m:
            try:
                q = float(m.group(1))
            except ValueError:
                q = 0.0
        result[token] = q
    return result


def encoding_acceptable(accepted, coding):
    q = accepted.get(coding)
    if q is None and coding == "gzip":
        q = accepted.get("x-gzip")
    if q is None:
        q = accepted.get("*", 0.0)
    return q > 0


def cache_control_for(path):
    """Cache-Control for a resolved file path ('' for no header)."""
    if IMMUTABLE_RE.search(path):
        return IMMUTABLE_CACHE_CONTROL
    return "no-cache" if os.path.splitext(path)[1].lower() in NO_CACHE_EXTENSIONS else ""


class Handler(BaseHTTPRequestHandler):
    server_version = "WiiCompiledServe/1.0"
    protocol_version = "HTTP/1.1"
    root = "."  # replaced per server in make_server()

    def setup(self):
        # TLS handshakes run here, in the connection's own thread, so one stalled client cannot
        # block accept() for everyone else.
        if isinstance(self.request, ssl.SSLSocket):
            self.request.settimeout(HANDSHAKE_TIMEOUT)
            self.request.do_handshake()
            self.request.settimeout(None)
        super().setup()

    # -- request plumbing ---------------------------------------------------
    def do_GET(self):
        self._serve(head_only=False)

    def do_HEAD(self):
        self._serve(head_only=True)

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Allow", "GET, HEAD, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _method_not_allowed(self):
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    do_POST = do_PUT = do_DELETE = do_PATCH = _method_not_allowed

    def _resolve(self):
        """Map the request path to a file inside root; None if missing/forbidden."""
        raw = urllib.parse.urlsplit(self.path).path
        try:
            path = urllib.parse.unquote(raw, errors="strict")
        except UnicodeDecodeError:
            return None
        if "\x00" in path:
            return None
        parts = [p for p in path.split("/") if p not in ("", ".")]
        if any(p == ".." for p in parts) or any(("\\" in p) for p in parts):
            return None
        full = os.path.join(self.root, *parts)
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        real = os.path.realpath(full)
        root_real = os.path.realpath(self.root)
        if real != root_real and not real.startswith(root_real + os.sep):
            return None
        return real if os.path.isfile(real) else None

    def _precompressed(self, path):
        """[(sibling_path, coding, stat)] of usable precompressed copies of `path`, best first."""
        found = []
        try:
            raw_mtime = os.stat(path).st_mtime
        except OSError:
            return found
        root_real = os.path.realpath(self.root)
        for coding, suffix in PRECOMPRESSED:
            sibling = path + suffix
            try:
                st = os.stat(sibling)
            except OSError:
                continue
            real = os.path.realpath(sibling)
            if not os.path.isfile(real) or not real.startswith(root_real + os.sep):
                continue
            if st.st_mtime + 2 < raw_mtime:
                continue  # older than the file it claims to be a copy of: stale
            found.append((sibling, coding, st))
        return found

    def _serve(self, head_only):
        path = self._resolve()
        if path is None:
            self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
            return
        try:
            st = os.stat(path)
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
            return
        range_header = self.headers.get("Range")
        siblings = self._precompressed(path)
        coding = None
        file_path = path
        if siblings and not range_header:
            accepted = accepted_encodings(self.headers.get("Accept-Encoding"))
            for sibling, candidate, sibling_st in siblings:
                if encoding_acceptable(accepted, candidate):
                    file_path, coding, st = sibling, candidate, sibling_st
                    break
        try:
            f = open(file_path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
            return
        with f:
            size = st.st_size
            cache_control = cache_control_for(path)
            try:
                rng = parse_range(range_header, size)
            except RangeError:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", "0")
                if siblings:
                    self.send_header("Vary", "Accept-Encoding")
                self.end_headers()
                return

            last_modified = email.utils.formatdate(st.st_mtime, usegmt=True)
            if rng is None:
                ims = self.headers.get("If-Modified-Since")
                if ims:
                    try:
                        parsed = email.utils.parsedate_to_datetime(ims)
                    except (TypeError, ValueError):
                        parsed = None
                    if parsed is not None and int(st.st_mtime) <= int(parsed.timestamp()):
                        self.send_response(HTTPStatus.NOT_MODIFIED)
                        self.send_header("Last-Modified", last_modified)
                        if cache_control:
                            self.send_header("Cache-Control", cache_control)
                        if siblings:
                            self.send_header("Vary", "Accept-Encoding")
                        self.end_headers()
                        return
                start, end = 0, size - 1
                self.send_response(HTTPStatus.OK)
            else:
                start, end = rng
                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            length = end - start + 1 if size else 0

            self.send_header("Content-Type", guess_type(path))
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "none" if coding else "bytes")
            self.send_header("Last-Modified", last_modified)
            if cache_control:
                self.send_header("Cache-Control", cache_control)
            if coding:
                self.send_header("Content-Encoding", coding)
            if siblings:
                self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
            if head_only or length == 0:
                return
            try:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, ssl.SSLError):
                self.close_connection = True

    def log_message(self, fmt, *args):
        if getattr(self.server, "quiet", False):
            return
        super().log_message(fmt, *args)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    quiet = False
    dropped = 0

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ssl.SSLError, ConnectionError, socket.timeout)):
            # Browsers abort the handshake while they do not trust a self-signed certificate, and
            # clients drop connections; neither deserves a traceback.
            self.dropped += 1
            if not self.quiet and self.dropped <= 3:
                sys.stderr.write("connection from %s dropped: %s\n" % (client_address[0], exc))
                if self.dropped == 1 and isinstance(exc, ssl.SSLError):
                    sys.stderr.write("  (normal while a browser has not accepted the self-signed certificate yet)\n")
            return
        super().handle_error(request, client_address)


class Server6(Server):
    address_family = socket.AF_INET6


def make_ssl_context(cert_file, key_file=None):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert_file, key_file)
    return ctx


def make_server(directory, bind="127.0.0.1", port=8080, quiet=False, ssl_context=None):
    handler = type("BoundHandler", (Handler,), {"root": os.path.abspath(directory)})
    server = (Server6 if ":" in bind else Server)((bind, port), handler)
    server.quiet = quiet
    if ssl_context is not None:
        server.socket = ssl_context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    return server


def urls_to_open(scheme, bind, port, lan_ips):
    """(url for this computer, [urls for other devices]) for a server bound to `bind`."""
    local = "%s://localhost:%d/" % (scheme, port)
    if bind in ("0.0.0.0", "::", ""):
        return local, ["%s://%s:%d/" % (scheme, ip, port) for ip in lan_ips]
    if bind in ("127.0.0.1", "localhost", "::1"):
        return local, []
    return "%s://%s:%d/" % (scheme, "[%s]" % bind if ":" in bind else bind, port), []


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Serve the WiiCompiled web build with HTTP Range support.")
    ap.add_argument("--dir", default=os.path.join(here, "dist"), help="directory to serve (default: web/dist)")
    ap.add_argument("--bind", default=None, help="address to bind (default: 127.0.0.1, only this computer)")
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces so other devices can connect (= --bind 0.0.0.0)")
    ap.add_argument("--port", type=int, default=8080, help="port (default: 8080)")
    ap.add_argument("--https", action="store_true",
                    help="serve HTTPS with a self-signed certificate generated on first use (other devices need HTTPS for WebGPU)")
    ap.add_argument("--cert", help="PEM certificate (chain) to serve instead of the generated one (implies --https)")
    ap.add_argument("--key", help="PEM private key for --cert (omit if the key is inside the --cert file)")
    ap.add_argument("--cert-dir", default=os.path.join(here, ".certs"),
                    help="where the generated certificate is cached (default: web/.certs)")
    ap.add_argument("--san", action="append", default=[], metavar="NAME_OR_IP",
                    help="extra host name or IP the generated certificate must be valid for (repeatable)")
    ap.add_argument("-q", "--quiet", action="store_true", help="do not log requests")
    args = ap.parse_args(argv)

    if args.lan and args.bind not in (None, "0.0.0.0", "::"):
        print("serve.py: error: --lan conflicts with --bind %s" % args.bind, file=sys.stderr)
        return 2
    bind = args.bind if args.bind is not None else ("0.0.0.0" if args.lan else "127.0.0.1")
    if args.key and not args.cert:
        print("serve.py: error: --key needs --cert", file=sys.stderr)
        return 2
    https = args.https or bool(args.cert)

    if not os.path.isdir(args.dir):
        print("serve.py: error: directory does not exist: %s (run web/build.sh first)" % args.dir, file=sys.stderr)
        return 1

    sys.path.insert(0, here)
    try:
        import selfsigned_cert  # certificate generation, lan_addresses(), fingerprint_sha256()
    except ImportError:  # serve.py copied somewhere without its helper: plain HTTP still works
        selfsigned_cert = None
    if https and selfsigned_cert is None and not args.cert:
        print("serve.py: error: selfsigned_cert.py is missing next to serve.py; pass --cert/--key instead", file=sys.stderr)
        return 1

    ssl_context = None
    generated = None
    cert_file = None
    if https:
        try:
            if args.cert:
                cert_file, key_file = args.cert, args.key
            else:
                generated = selfsigned_cert.ensure_certificate(
                    args.cert_dir, args.san, log=lambda m: print("serve.py: " + m))
                cert_file, key_file = generated.cert_path, generated.key_path
            ssl_context = make_ssl_context(cert_file, key_file)
        except (OSError, ssl.SSLError, RuntimeError) as e:
            print("serve.py: error: cannot set up HTTPS: %s" % e, file=sys.stderr)
            return 1

    try:
        server = make_server(args.dir, bind, args.port, args.quiet, ssl_context)
    except OSError as e:
        print("serve.py: error: cannot listen on %s:%d: %s" % (bind, args.port, e), file=sys.stderr)
        return 1

    port = server.server_address[1]
    scheme = "https" if https else "http"
    lan_ips = selfsigned_cert.lan_addresses() if selfsigned_cert and bind in ("0.0.0.0", "::", "") else []
    local_url, lan_urls = urls_to_open(scheme, bind, port, lan_ips)
    print("Serving %s (Ctrl+C to stop)" % os.path.abspath(args.dir))
    print("  Open on this computer:   %s" % local_url)
    for url in lan_urls:
        print("  Open from other devices: %s" % url)
    if bind in ("0.0.0.0", "::", "") and not lan_urls:
        print("  (no LAN address found; use this computer's IP address or name with port %d)" % port)
    if https:
        if generated is not None:
            names = [x.split(":", 1)[1] for x in generated.sans]
            print("  Certificate: %s" % generated.cert_path)
            print("  Valid for:   %s" % ", ".join(names[:8]) + (" ..." if len(names) > 8 else ""))
        fingerprint = selfsigned_cert.fingerprint_sha256(cert_file) if selfsigned_cert else None
        if fingerprint:
            print("  SHA-256 fingerprint: %s" % fingerprint)
        if generated is not None:
            print("  Browsers warn \"Your connection is not private\" for a self-signed certificate: nobody they")
            print("  know vouches for it. On your own network that is expected. In Chrome/Edge choose Advanced,")
            print("  then Proceed to <address> (once per device); the page is still a secure context, so WebGPU")
            print("  works. For a certificate devices trust without a warning use --cert/--key, Caddy, or a")
            print("  tunnel (docs/web-hosting.md).")
        if bind in ("127.0.0.1", "localhost", "::1"):
            print("  Note: bound to this computer only; add --lan to let other devices connect.")
    elif bind not in ("127.0.0.1", "localhost", "::1"):
        print("Note: WebGPU needs a secure context; other devices must reach this over HTTPS (add --https).", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
