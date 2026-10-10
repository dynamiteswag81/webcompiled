"""Tests for web/serve.py --https and web/selfsigned_cert.py (stdlib only; uses `openssl` when present).

Run:  python3 -m unittest web/tests/test_serve_https.py -v
"""

import base64
import hashlib
import http.client
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import selfsigned_cert as sc  # noqa: E402
import serve  # noqa: E402

PAYLOAD = bytes(range(256)) * 40
HAVE_OPENSSL = shutil.which("openssl") is not None


def slurp(path):
    with open(path) as f:
        return f.read()


def pem_to_der(path):
    with open(path) as f:
        text = f.read()
    m = re.search(r"-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", text, re.S)
    return base64.b64decode("".join(m.group(1).split()))


def read_tlv(data, pos):
    tag = data[pos]
    first = data[pos + 1]
    if first < 0x80:
        length, start = first, pos + 2
    else:
        n = first & 0x7F
        length, start = int.from_bytes(data[pos + 2:pos + 2 + n], "big"), pos + 2 + n
    return tag, start, start + length


def verify_self_signature(der):
    """Independent ECDSA P-256/SHA-256 check of a self-signed certificate made by selfsigned_cert."""
    _, body, end = read_tlv(der, 0)
    tbs_tag, tbs_body, tbs_end = read_tlv(der, body)
    tbs = der[body:tbs_end]
    _, _, alg_end = read_tlv(der, tbs_end)
    sig_tag, sig_body, sig_end = read_tlv(der, alg_end)
    assert sig_tag == 0x03 and sig_end == end
    sig = der[sig_body + 1:sig_end]
    _, rb, re_ = read_tlv(sig, 0)
    _, r_body, r_end = read_tlv(sig, rb)
    _, s_body, s_end = read_tlv(sig, r_end)
    r = int.from_bytes(sig[r_body:r_end], "big")
    s = int.from_bytes(sig[s_body:s_end], "big")
    # public key: the 0x04 || X || Y after the SPKI's BIT STRING
    marker = b"\x03\x42\x00\x04"
    at = tbs.index(marker) + len(marker)
    point = (int.from_bytes(tbs[at:at + 32], "big"), int.from_bytes(tbs[at + 32:at + 64], "big"))
    n = sc._N
    e = int.from_bytes(hashlib.sha256(tbs).digest(), "big")
    w = pow(s, -1, n)
    p = sc._point_add(sc._scalar_mult(e * w % n, sc._G), sc._scalar_mult(r * w % n, point))
    return p is not None and p[0] % n == r


def decode_cert(path):
    """Decoded certificate dict (subjectAltName etc.) via CPython's test hook."""
    return ssl._ssl._test_decode_cert(path)


def backends():
    out = ["python"]
    if HAVE_OPENSSL:
        out.append("openssl")
    return out


class CurveTest(unittest.TestCase):
    def test_generator_and_order(self):
        self.assertTrue(sc._on_curve(sc._G))
        self.assertIsNone(sc._scalar_mult(sc._N, sc._G))
        self.assertEqual(sc._scalar_mult(sc._N - 1, sc._G)[0], sc._GX)

    def test_known_scalar_multiple(self):
        # 2G for NIST P-256 (from the standard test vectors)
        x, y = sc._scalar_mult(2, sc._G)
        self.assertEqual(x, 0x7CF27B188D034F7E8A52380304B51AC3C08969E277F21B35A60B48FC47669978)
        self.assertEqual(y, 0x07775510DB8ED040293D9AC69F7430DBBA7DADE63CE982299E04B79D227873D1)


class CertificateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_san_discovery(self):
        dns, ips = sc.wanted_names(["my-host.example", "10.9.8.7"])
        self.assertIn("localhost", dns)
        self.assertIn("my-host.example", dns)
        self.assertIn("127.0.0.1", ips)
        self.assertIn("::1", ips)
        self.assertIn("10.9.8.7", ips)
        for ip in sc.lan_addresses():
            self.assertNotIn(ip.split(".")[0], ("127",))

    def test_generated_certificate_contents(self):
        for backend in backends():
            with self.subTest(backend=backend):
                d = os.path.join(self.tmp.name, backend)
                cert = sc.ensure_certificate(d, ["lan.example", "192.0.2.77"], backend=backend)
                self.assertTrue(cert.generated)
                self.assertEqual(cert.backend, backend)
                info = decode_cert(cert.cert_path)
                sans = set(info["subjectAltName"])
                self.assertIn(("DNS", "localhost"), sans)
                self.assertIn(("DNS", "lan.example"), sans)
                self.assertIn(("IP Address", "127.0.0.1"), sans)
                self.assertIn(("IP Address", "192.0.2.77"), sans)
                self.assertIn(("IP Address", "0:0:0:0:0:0:0:1"), sans)
                for ip in sc.lan_addresses():
                    self.assertIn(("IP Address", ip), sans)
                self.assertTrue(verify_self_signature(pem_to_der(cert.cert_path)) or backend == "openssl")
                if os.name == "posix":
                    self.assertEqual(os.stat(cert.key_path).st_mode & 0o077, 0, "private key must not be group/world readable")

    @unittest.skipUnless(HAVE_OPENSSL, "openssl command not available")
    def test_openssl_agrees(self):
        for backend in backends():
            with self.subTest(backend=backend):
                d = os.path.join(self.tmp.name, "o-" + backend)
                cert = sc.ensure_certificate(d, ["lan.example"], backend=backend)
                text = subprocess.run(["openssl", "x509", "-in", cert.cert_path, "-noout", "-text"],
                                      stdout=subprocess.PIPE, universal_newlines=True, check=True).stdout
                self.assertIn("DNS:localhost", text)
                self.assertIn("DNS:lan.example", text)
                self.assertIn("IP Address:127.0.0.1", text)
                self.assertIn("TLS Web Server Authentication", text)
                self.assertIn("CA:FALSE", text)
                self.assertIn("ecdsa-with-SHA256", text)
                done = subprocess.run(["openssl", "verify", "-check_ss_sig", "-CAfile", cert.cert_path, cert.cert_path],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                key = subprocess.run(["openssl", "pkey", "-in", cert.key_path, "-noout", "-check"],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
                self.assertEqual(key.returncode, 0, key.stderr)

    def test_python_signature_detects_tampering(self):
        d = os.path.join(self.tmp.name, "tamper")
        cert = sc.ensure_certificate(d, backend="python")
        der = bytearray(pem_to_der(cert.cert_path))
        self.assertTrue(verify_self_signature(bytes(der)))
        der[60] ^= 1  # inside the TBS part
        try:
            self.assertFalse(verify_self_signature(bytes(der)))
        except (ValueError, IndexError, AssertionError):
            pass  # structurally broken is just as good

    def test_cache_and_renewal(self):
        d = os.path.join(self.tmp.name, "cache")
        first = sc.ensure_certificate(d, backend="python")
        self.assertTrue(first.generated)
        before = slurp(first.cert_path)
        second = sc.ensure_certificate(d, backend="python")
        self.assertFalse(second.generated)
        self.assertEqual(slurp(second.cert_path), before)
        # A new name forces a new certificate that still covers the old names.
        third = sc.ensure_certificate(d, ["new.example"], backend="python")
        self.assertTrue(third.generated)
        self.assertIn("DNS:new.example", third.sans)
        self.assertTrue(set(first.sans) <= set(third.sans))
        self.assertNotEqual(slurp(third.cert_path), before)
        self.assertFalse(sc.ensure_certificate(d, ["new.example"], backend="python").generated)
        # About to expire: renewed.
        meta = os.path.join(d, sc.META_NAME)
        with open(meta) as f:
            data = json.load(f)
        data["not_after"] = 0
        with open(meta, "w") as f:
            json.dump(data, f)
        self.assertTrue(sc.ensure_certificate(d, ["new.example"], backend="python").generated)

    def test_fingerprint(self):
        d = os.path.join(self.tmp.name, "fp")
        cert = sc.ensure_certificate(d, backend="python")
        fp = sc.fingerprint_sha256(cert.cert_path)
        self.assertEqual(fp.replace(":", "").lower(), hashlib.sha256(pem_to_der(cert.cert_path)).hexdigest())


class HttpsServerTest(unittest.TestCase):
    """Real TLS handshakes against the generated certificates, with verification switched on."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = os.path.join(cls.tmp.name, "root")
        os.makedirs(os.path.join(cls.root, "disc"))
        with open(os.path.join(cls.root, "index.html"), "w") as f:
            f.write("<!doctype html><title>t</title>")
        with open(os.path.join(cls.root, "disc", "blob.szs"), "wb") as f:
            f.write(PAYLOAD)
        cls.servers = {}
        for backend in backends():
            cert = sc.ensure_certificate(os.path.join(cls.tmp.name, "certs-" + backend), backend=backend)
            server = serve.make_server(cls.root, "127.0.0.1", 0, quiet=True,
                                       ssl_context=serve.make_ssl_context(cert.cert_path, cert.key_path))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            cls.servers[backend] = (server, cert)

    @classmethod
    def tearDownClass(cls):
        for server, _ in cls.servers.values():
            server.shutdown()
            server.server_close()
        cls.tmp.cleanup()

    def connect(self, backend, host="localhost", verify=True):
        server, cert = self.servers[backend]
        ctx = ssl.create_default_context(cafile=cert.cert_path) if verify else ssl._create_unverified_context()
        conn = http.client.HTTPSConnection(host, server.server_address[1], timeout=10, context=ctx)
        return conn

    def get(self, backend, path, headers=None, host="localhost", method="GET"):
        conn = self.connect(backend, host)
        try:
            conn.request(method, path, headers=headers or {})
            resp = conn.getresponse()
            return resp, resp.read()
        finally:
            conn.close()

    def test_handshake_verifies_names(self):
        for backend in self.servers:
            for host in ("localhost", "127.0.0.1"):
                with self.subTest(backend=backend, host=host):
                    resp, body = self.get(backend, "/", host=host)
                    self.assertEqual(resp.status, 200)
                    self.assertIn(b"<title>t</title>", body)

    def test_wrong_name_is_rejected(self):
        for backend in self.servers:
            with self.subTest(backend=backend):
                server, cert = self.servers[backend]
                ctx = ssl.create_default_context(cafile=cert.cert_path)
                with self.assertRaises(ssl.SSLCertVerificationError):
                    conn = http.client.HTTPSConnection("localhost", server.server_address[1], timeout=10, context=ctx)
                    conn.sock = ctx.wrap_socket(__import__("socket").create_connection(("127.0.0.1", server.server_address[1])),
                                                server_hostname="not-in-the-certificate.example")

    def test_range_over_tls(self):
        for backend in self.servers:
            with self.subTest(backend=backend):
                resp, body = self.get(backend, "/disc/blob.szs", {"Range": "bytes=100-199"})
                self.assertEqual(resp.status, 206)
                self.assertEqual(body, PAYLOAD[100:200])
                self.assertEqual(resp.getheader("Content-Range"), "bytes 100-199/%d" % len(PAYLOAD))
                resp, body = self.get(backend, "/disc/blob.szs", {"Range": "bytes=-16"})
                self.assertEqual(body, PAYLOAD[-16:])
                resp, _ = self.get(backend, "/disc/blob.szs", {"Range": "bytes=99999-"})
                self.assertEqual(resp.status, 416)
                resp, body = self.get(backend, "/disc/blob.szs", method="HEAD")
                self.assertEqual(resp.getheader("Content-Length"), str(len(PAYLOAD)))

    def test_keep_alive_over_tls(self):
        backend = next(iter(self.servers))
        conn = self.connect(backend)
        try:
            for i in range(4):
                conn.request("GET", "/disc/blob.szs", headers={"Range": "bytes=%d-%d" % (i, i + 3)})
                resp = conn.getresponse()
                self.assertEqual(resp.status, 206)
                self.assertEqual(resp.read(), PAYLOAD[i:i + 4])
        finally:
            conn.close()

    def test_plain_http_and_stalled_clients_do_not_break_the_server(self):
        import socket

        backend = next(iter(self.servers))
        server, _ = self.servers[backend]
        port = server.server_address[1]
        with socket.create_connection(("127.0.0.1", port), timeout=5) as raw:  # plain HTTP to a TLS port
            raw.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            try:
                raw.recv(100)
            except OSError:
                pass
        stalled = socket.create_connection(("127.0.0.1", port), timeout=5)  # connects, never handshakes
        try:
            resp, _ = self.get(backend, "/")  # the accept loop must not be blocked by it
            self.assertEqual(resp.status, 200)
        finally:
            stalled.close()


class CommandLineTest(unittest.TestCase):
    def test_urls_to_open(self):
        self.assertEqual(serve.urls_to_open("https", "127.0.0.1", 8080, ["192.168.1.5"]), ("https://localhost:8080/", []))
        local, lan = serve.urls_to_open("https", "0.0.0.0", 8443, ["192.168.1.5", "10.0.0.2"])
        self.assertEqual(local, "https://localhost:8443/")
        self.assertEqual(lan, ["https://192.168.1.5:8443/", "https://10.0.0.2:8443/"])
        self.assertEqual(serve.urls_to_open("http", "192.168.1.5", 80, [])[0], "http://192.168.1.5:80/")

    def run_main(self, *argv):
        script = os.path.join(os.path.dirname(serve.__file__), "serve.py")
        return subprocess.run([sys.executable, script, *argv], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=30)

    def test_argument_errors(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        result = self.run_main("--dir", tmp, "--key", "k.pem")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--key needs --cert", result.stderr)
        result = self.run_main("--dir", tmp, "--lan", "--bind", "127.0.0.1")
        self.assertEqual(result.returncode, 2)
        result = self.run_main("--dir", tmp, "--cert", os.path.join(tmp, "missing.pem"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot set up HTTPS", result.stderr)

    def test_https_lan_end_to_end(self):
        """serve.py --https --lan --cert-dir ...: prints the URLs, serves TLS on a LAN address."""
        import time

        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        site = os.path.join(tmp, "site")
        os.makedirs(site)
        with open(os.path.join(site, "index.html"), "w") as f:
            f.write("hello")
        import socket

        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        script = os.path.join(os.path.dirname(serve.__file__), "serve.py")
        proc = subprocess.Popen([sys.executable, "-u", script, "--dir", site, "--https", "--lan", "--port", str(port),
                                 "--cert-dir", os.path.join(tmp, "certs"), "--san", "demo.example", "-q"],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        self.addCleanup(proc.stdout.close)
        self.addCleanup(proc.wait)
        self.addCleanup(proc.terminate)
        try:
            deadline = time.time() + 20
            lines = []
            while time.time() < deadline:
                line = proc.stdout.readline()
                if not line:
                    break
                lines.append(line)
                if "tunnel" in line:  # last line of the explanation
                    break
            text = "".join(lines)
            self.assertIn("https://localhost:%d/" % port, text)
            self.assertIn("not private", text)
            self.assertIn("SHA-256 fingerprint", text)
            for ip in sc.lan_addresses():
                self.assertIn("https://%s:%d/" % (ip, port), text)
            cert = os.path.join(tmp, "certs", sc.CERT_NAME)
            ctx = ssl.create_default_context(cafile=cert)
            for host in ["localhost", "demo.example"] + sc.lan_addresses()[:1]:
                target = "127.0.0.1" if host == "demo.example" else host
                conn = http.client.HTTPSConnection(target, port, timeout=10, context=ctx)
                if host == "demo.example":  # name is in the certificate; connect to loopback with that SNI/name check
                    raw = socket.create_connection(("127.0.0.1", port), timeout=10)
                    conn.sock = ctx.wrap_socket(raw, server_hostname=host)
                conn.request("GET", "/")
                resp = conn.getresponse()
                self.assertEqual((resp.status, resp.read()), (200, b"hello"), host)
                conn.close()
        finally:
            proc.terminate()


if __name__ == "__main__":
    unittest.main()
