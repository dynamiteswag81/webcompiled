"""Tests for web/serve.py (stdlib only).  Run:  python3 -m unittest web/tests/test_serve.py -v"""

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


if __name__ == "__main__":
    unittest.main()
