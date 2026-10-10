"""Tests for web/serve.py (stdlib only).  Run:  python3 -m unittest web/tests/test_serve.py -v"""

import gzip
import http.client
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import serve  # noqa: E402

PAYLOAD = bytes(range(256)) * 40  # 10240 bytes, easy to verify slices


class ServeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = os.path.join(cls.tmp.name, "root")
        os.makedirs(root)
        with open(os.path.join(root, "index.html"), "w") as f:
            f.write("<!doctype html><title>t</title>")
        with open(os.path.join(root, "app.js"), "w") as f:
            f.write("console.log(1)")
        with open(os.path.join(root, "data.json"), "w") as f:
            f.write("{}")
        with open(os.path.join(root, "m.wasm"), "wb") as f:
            f.write(b"\0asm\1\0\0\0")
        with open(os.path.join(root, "empty.bin"), "wb"):
            pass
        os.makedirs(os.path.join(root, "disc", "files"))
        with open(os.path.join(root, "disc", "files", "blob.szs"), "wb") as f:
            f.write(PAYLOAD)
        with open(os.path.join(cls.tmp.name, "secret-outside.txt"), "w") as f:
            f.write("secret")
        cls.server = serve.make_server(root, "127.0.0.1", 0, quiet=True)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, headers=headers or {})
            resp = conn.getresponse()
            return resp, resp.read()
        finally:
            conn.close()

    BLOB = "/disc/files/blob.szs"

    def test_full_get(self):
        resp, body = self.request("GET", self.BLOB)
        self.assertEqual(resp.status, 200)
        self.assertEqual(body, PAYLOAD)
        self.assertEqual(resp.getheader("Accept-Ranges"), "bytes")
        self.assertEqual(resp.getheader("Content-Length"), str(len(PAYLOAD)))
        self.assertEqual(resp.getheader("Content-Type"), "application/octet-stream")

    def test_range_a_b(self):
        resp, body = self.request("GET", self.BLOB, {"Range": "bytes=10-19"})
        self.assertEqual(resp.status, 206)
        self.assertEqual(body, PAYLOAD[10:20])
        self.assertEqual(resp.getheader("Content-Range"), "bytes 10-19/%d" % len(PAYLOAD))
        self.assertEqual(resp.getheader("Content-Length"), "10")

    def test_range_open_ended(self):
        resp, body = self.request("GET", self.BLOB, {"Range": "bytes=10000-"})
        self.assertEqual(resp.status, 206)
        self.assertEqual(body, PAYLOAD[10000:])
        self.assertEqual(resp.getheader("Content-Range"), "bytes 10000-10239/10240")

    def test_range_suffix(self):
        resp, body = self.request("GET", self.BLOB, {"Range": "bytes=-16"})
        self.assertEqual(resp.status, 206)
        self.assertEqual(body, PAYLOAD[-16:])
        self.assertEqual(resp.getheader("Content-Range"), "bytes 10224-10239/10240")

    def test_range_suffix_larger_than_file(self):
        resp, body = self.request("GET", self.BLOB, {"Range": "bytes=-999999"})
        self.assertEqual(resp.status, 206)
        self.assertEqual(body, PAYLOAD)
        self.assertEqual(resp.getheader("Content-Range"), "bytes 0-10239/10240")

    def test_range_end_clamped(self):
        resp, body = self.request("GET", self.BLOB, {"Range": "bytes=10200-99999"})
        self.assertEqual(resp.status, 206)
        self.assertEqual(body, PAYLOAD[10200:])

    def test_range_single_byte(self):
        resp, body = self.request("GET", self.BLOB, {"Range": "bytes=0-0"})
        self.assertEqual(resp.status, 206)
        self.assertEqual(body, PAYLOAD[:1])

    def test_range_unsatisfiable(self):
        for value in ("bytes=10240-", "bytes=99999-100000", "bytes=-0"):
            resp, body = self.request("GET", self.BLOB, {"Range": value})
            self.assertEqual(resp.status, 416, value)
            self.assertEqual(resp.getheader("Content-Range"), "bytes */10240", value)
            self.assertEqual(body, b"")

    def test_range_on_empty_file(self):
        resp, _ = self.request("GET", "/empty.bin", {"Range": "bytes=0-0"})
        self.assertEqual(resp.status, 416)
        resp, body = self.request("GET", "/empty.bin")
        self.assertEqual(resp.status, 200)
        self.assertEqual(body, b"")

    def test_ignored_ranges_serve_full_body(self):
        for value in ("bytes=0-1,5-6", "items=0-5", "bytes=abc", "bytes=9-3"):
            resp, body = self.request("GET", self.BLOB, {"Range": value})
            self.assertEqual(resp.status, 200, value)
            self.assertEqual(body, PAYLOAD, value)

    def test_head(self):
        resp, body = self.request("HEAD", self.BLOB)
        self.assertEqual(resp.status, 200)
        self.assertEqual(body, b"")
        self.assertEqual(resp.getheader("Content-Length"), str(len(PAYLOAD)))
        self.assertEqual(resp.getheader("Accept-Ranges"), "bytes")

    def test_head_range(self):
        resp, body = self.request("HEAD", self.BLOB, {"Range": "bytes=0-9"})
        self.assertEqual(resp.status, 206)
        self.assertEqual(body, b"")
        self.assertEqual(resp.getheader("Content-Length"), "10")
        self.assertEqual(resp.getheader("Content-Range"), "bytes 0-9/10240")

    def test_mime_types(self):
        cases = {
            "/m.wasm": "application/wasm",
            "/app.js": "text/javascript; charset=utf-8",
            "/data.json": "application/json",
            "/index.html": "text/html; charset=utf-8",
            "/": "text/html; charset=utf-8",
        }
        for path, expected in cases.items():
            resp, _ = self.request("GET", path)
            self.assertEqual(resp.status, 200, path)
            self.assertEqual(resp.getheader("Content-Type"), expected, path)

    def test_cache_control(self):
        for path in ("/", "/app.js", "/m.wasm", "/data.json"):
            resp, _ = self.request("GET", path)
            self.assertEqual(resp.getheader("Cache-Control"), "no-cache", path)

    def test_not_found_and_traversal(self):
        resp, _ = self.request("GET", "/nope.txt")
        self.assertEqual(resp.status, 404)
        resp, _ = self.request("GET", "/../secret-outside.txt")
        self.assertEqual(resp.status, 404)
        resp, _ = self.request("GET", "/%2e%2e/secret-outside.txt")
        self.assertEqual(resp.status, 404)

    def test_if_modified_since(self):
        resp, _ = self.request("GET", "/app.js")
        lm = resp.getheader("Last-Modified")
        self.assertTrue(lm)
        resp, body = self.request("GET", "/app.js", {"If-Modified-Since": lm})
        self.assertEqual(resp.status, 304)
        self.assertEqual(body, b"")

    def test_keep_alive_multiple_requests(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            for i in range(3):
                conn.request("GET", self.BLOB, headers={"Range": "bytes=%d-%d" % (i, i + 3)})
                resp = conn.getresponse()
                self.assertEqual(resp.status, 206)
                self.assertEqual(resp.read(), PAYLOAD[i : i + 4])
        finally:
            conn.close()

    def test_parse_range_unit(self):
        self.assertIsNone(serve.parse_range(None, 100))
        self.assertEqual(serve.parse_range("bytes=0-", 100), (0, 99))
        self.assertEqual(serve.parse_range("bytes=-1", 100), (99, 99))
        with self.assertRaises(serve.RangeError):
            serve.parse_range("bytes=100-", 100)


HASHED = "/Game.1a2b3c4d.wasm"
RAW_WASM = b"\0asm\1\0\0\0" + b"A" * 50000
GZ_WASM = gzip.compress(RAW_WASM, 9)
BR_WASM = b"not-really-brotli-but-the-server-does-not-look" * 5  # distinct bytes and length


class PrecompressedTest(unittest.TestCase):
    """Content-hashed names, Cache-Control and .br/.gz siblings."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = cls.root = os.path.join(cls.tmp.name, "root")
        os.makedirs(root)

        def write(name, data):
            with open(os.path.join(root, name), "wb") as f:
                f.write(data)

        write("Game.1a2b3c4d.wasm", RAW_WASM)
        write("Game.1a2b3c4d.wasm.gz", GZ_WASM)
        write("Game.1a2b3c4d.wasm.br", BR_WASM)
        write("Only.0badc0de.wasm", RAW_WASM)          # hashed, nothing precompressed
        write("Gz.aaaaaaaa.wasm", RAW_WASM)
        write("Gz.aaaaaaaa.wasm.gz", GZ_WASM)          # only gzip
        write("plain.wasm", RAW_WASM)                  # unhashed: must stay no-cache
        write("plain.wasm.gz", GZ_WASM)
        write("stale.js", b"console.log('new')" * 100)
        write("stale.js.gz", gzip.compress(b"old"))
        old = os.path.getmtime(os.path.join(root, "stale.js")) - 1000
        os.utime(os.path.join(root, "stale.js.gz"), (old, old))
        write("index.html", b"<!doctype html>")
        cls.server = serve.make_server(root, "127.0.0.1", 0, quiet=True)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, headers=headers or {})
            resp = conn.getresponse()
            return resp, resp.read()
        finally:
            conn.close()

    def test_hashed_wasm_is_immutable(self):
        for path in (HASHED, "/Only.0badc0de.wasm", HASHED + ".gz", HASHED + ".br"):
            resp, _ = self.request("GET", path)
            self.assertEqual(resp.status, 200, path)
            self.assertEqual(resp.getheader("Cache-Control"), "public, max-age=31536000, immutable", path)

    def test_unhashed_and_text_stay_no_cache(self):
        for path in ("/plain.wasm", "/index.html", "/stale.js"):
            resp, _ = self.request("GET", path, {"Accept-Encoding": "gzip, br"})
            self.assertEqual(resp.getheader("Cache-Control"), "no-cache", path)

    def test_brotli_preferred_over_gzip(self):
        resp, body = self.request("GET", HASHED, {"Accept-Encoding": "gzip, deflate, br"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("Content-Encoding"), "br")
        self.assertEqual(body, BR_WASM)
        self.assertEqual(resp.getheader("Content-Length"), str(len(BR_WASM)))
        self.assertEqual(resp.getheader("Content-Type"), "application/wasm")
        self.assertEqual(resp.getheader("Vary"), "Accept-Encoding")
        self.assertEqual(resp.getheader("Cache-Control"), "public, max-age=31536000, immutable")

    def test_gzip_when_only_gzip_accepted(self):
        resp, body = self.request("GET", HASHED, {"Accept-Encoding": "gzip"})
        self.assertEqual(resp.getheader("Content-Encoding"), "gzip")
        self.assertEqual(body, GZ_WASM)
        self.assertEqual(gzip.decompress(body), RAW_WASM)
        self.assertEqual(resp.getheader("Content-Length"), str(len(GZ_WASM)))
        self.assertEqual(resp.getheader("Content-Type"), "application/wasm")

    def test_q_values_and_star(self):
        cases = [
            ("br;q=0, gzip", "gzip"),
            ("gzip;q=0, br;q=0", None),
            ("*", "br"),
            ("identity", None),
            ("br;q=0.5, gzip;q=1", "br"),  # preference order is ours, any q > 0 qualifies
            ("x-gzip", "gzip"),
            ("", None),
        ]
        for accept, want in cases:
            resp, _ = self.request("GET", HASHED, {"Accept-Encoding": accept})
            self.assertEqual(resp.getheader("Content-Encoding"), want, accept)
            self.assertEqual(resp.getheader("Vary"), "Accept-Encoding", accept)

    def test_no_accept_encoding_gets_identity_with_vary(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest("GET", HASHED, skip_accept_encoding=True)
            conn.endheaders()
            resp = conn.getresponse()
            body = resp.read()
        finally:
            conn.close()
        self.assertIsNone(resp.getheader("Content-Encoding"))
        self.assertEqual(body, RAW_WASM)
        self.assertEqual(resp.getheader("Vary"), "Accept-Encoding")
        self.assertEqual(resp.getheader("Accept-Ranges"), "bytes")

    def test_range_gets_uncompressed_bytes(self):
        resp, body = self.request("GET", HASHED, {"Accept-Encoding": "gzip, br", "Range": "bytes=4-11"})
        self.assertEqual(resp.status, 206)
        self.assertIsNone(resp.getheader("Content-Encoding"))
        self.assertEqual(body, RAW_WASM[4:12])
        self.assertEqual(resp.getheader("Content-Range"), "bytes 4-11/%d" % len(RAW_WASM))
        self.assertEqual(resp.getheader("Vary"), "Accept-Encoding")

    def test_head_reports_encoded_length(self):
        resp, body = self.request("HEAD", HASHED, {"Accept-Encoding": "gzip"})
        self.assertEqual(body, b"")
        self.assertEqual(resp.getheader("Content-Encoding"), "gzip")
        self.assertEqual(resp.getheader("Content-Length"), str(len(GZ_WASM)))

    def test_only_existing_siblings_are_used(self):
        resp, body = self.request("GET", "/Gz.aaaaaaaa.wasm", {"Accept-Encoding": "br, gzip"})
        self.assertEqual(resp.getheader("Content-Encoding"), "gzip")
        resp, body = self.request("GET", "/Only.0badc0de.wasm", {"Accept-Encoding": "br, gzip"})
        self.assertIsNone(resp.getheader("Content-Encoding"))
        self.assertIsNone(resp.getheader("Vary"))
        self.assertEqual(body, RAW_WASM)

    def test_unhashed_file_with_sibling_is_compressed_but_revalidated(self):
        resp, body = self.request("GET", "/plain.wasm", {"Accept-Encoding": "gzip"})
        self.assertEqual(resp.getheader("Content-Encoding"), "gzip")
        self.assertEqual(body, GZ_WASM)
        self.assertEqual(resp.getheader("Cache-Control"), "no-cache")

    def test_stale_sibling_ignored(self):
        resp, body = self.request("GET", "/stale.js", {"Accept-Encoding": "gzip"})
        self.assertIsNone(resp.getheader("Content-Encoding"))
        self.assertTrue(body.startswith(b"console.log"))

    def test_sibling_itself_is_served_as_a_plain_file(self):
        resp, body = self.request("GET", HASHED + ".gz", {"Accept-Encoding": "gzip"})
        self.assertIsNone(resp.getheader("Content-Encoding"))
        self.assertEqual(resp.getheader("Content-Type"), "application/gzip")
        self.assertEqual(body, GZ_WASM)

    def test_conditional_get_keeps_headers(self):
        resp, _ = self.request("GET", HASHED, {"Accept-Encoding": "gzip"})
        lm = resp.getheader("Last-Modified")
        resp, body = self.request("GET", HASHED, {"Accept-Encoding": "gzip", "If-Modified-Since": lm})
        self.assertEqual(resp.status, 304)
        self.assertEqual(body, b"")
        self.assertEqual(resp.getheader("Cache-Control"), "public, max-age=31536000, immutable")
        self.assertEqual(resp.getheader("Vary"), "Accept-Encoding")

    def test_helpers(self):
        self.assertEqual(serve.accepted_encodings("gzip;q=0.5, br"), {"gzip": 0.5, "br": 1.0})
        self.assertTrue(serve.encoding_acceptable({"*": 1.0}, "gzip"))
        self.assertFalse(serve.encoding_acceptable({"gzip": 0.0, "*": 1.0}, "gzip"))
        self.assertFalse(serve.encoding_acceptable({}, "br"))


if __name__ == "__main__":
    unittest.main()
