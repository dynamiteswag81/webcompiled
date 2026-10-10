#!/usr/bin/env python3
"""Tiny static file server for the WiiCompiled web build (Python 3 standard library only).

    python3 web/serve.py [--dir web/dist] [--bind 127.0.0.1] [--port 8080]

Why not `python -m http.server`: the game streams the extracted disc tree with HTTP Range
requests, and `http.server` ignores Range. This server supports single ranges (`bytes=a-b`,
`bytes=a-`, `bytes=-n`), answers 206 with Content-Range (416 when unsatisfiable), serves
`.wasm` as application/wasm and marks html/js/wasm/json as `Cache-Control: no-cache`.

127.0.0.1 counts as a secure context, which WebGPU requires; for other hosts you need HTTPS.
"""

import argparse
import email.utils
import mimetypes
import os
import re
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
}
NO_CACHE_EXTENSIONS = {".html", ".htm", ".js", ".mjs", ".wasm", ".json"}

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


class Handler(BaseHTTPRequestHandler):
    server_version = "WiiCompiledServe/1.0"
    protocol_version = "HTTP/1.1"
    root = "."  # replaced per server in make_server()

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

    def _serve(self, head_only):
        path = self._resolve()
        if path is None:
            self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
            return
        try:
            st = os.stat(path)
            f = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
            return
        with f:
            size = st.st_size
            ext = os.path.splitext(path)[1].lower()
            try:
                rng = parse_range(self.headers.get("Range"), size)
            except RangeError:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

            last_modified = email.utils.formatdate(st.st_mtime, usegmt=True)
            if rng is None:
                ims = self.headers.get("If-Modified-Since")
                if ims:
                    parsed = email.utils.parsedate_to_datetime(ims) if ims else None
                    if parsed is not None and int(st.st_mtime) <= int(parsed.timestamp()):
                        self.send_response(HTTPStatus.NOT_MODIFIED)
                        self.send_header("Last-Modified", last_modified)
                        if ext in NO_CACHE_EXTENSIONS:
                            self.send_header("Cache-Control", "no-cache")
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
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Last-Modified", last_modified)
            if ext in NO_CACHE_EXTENSIONS:
                self.send_header("Cache-Control", "no-cache")
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
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                self.close_connection = True

    def log_message(self, fmt, *args):
        if getattr(self.server, "quiet", False):
            return
        super().log_message(fmt, *args)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    quiet = False


def make_server(directory, bind="127.0.0.1", port=8080, quiet=False):
    handler = type("BoundHandler", (Handler,), {"root": os.path.abspath(directory)})
    server = Server((bind, port), handler)
    server.quiet = quiet
    return server


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Serve the WiiCompiled web build with HTTP Range support.")
    ap.add_argument("--dir", default=os.path.join(here, "dist"), help="directory to serve (default: web/dist)")
    ap.add_argument("--bind", default="127.0.0.1", help="address to bind (default: 127.0.0.1)")
    ap.add_argument("--port", type=int, default=8080, help="port (default: 8080)")
    ap.add_argument("-q", "--quiet", action="store_true", help="do not log requests")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.dir):
        print("serve.py: error: directory does not exist: %s (run web/build.sh first)" % args.dir, file=sys.stderr)
        return 1
    try:
        server = make_server(args.dir, args.bind, args.port, args.quiet)
    except OSError as e:
        print("serve.py: error: cannot listen on %s:%d: %s" % (args.bind, args.port, e), file=sys.stderr)
        return 1
    host = "localhost" if args.bind in ("127.0.0.1", "0.0.0.0", "::") else args.bind
    print("Serving %s on http://%s:%d/ (Ctrl+C to stop)" % (os.path.abspath(args.dir), host, server.server_address[1]))
    if args.bind not in ("127.0.0.1", "localhost", "::1"):
        print("Note: WebGPU needs a secure context; non-localhost clients must reach this over HTTPS.", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
