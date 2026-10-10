"""Tests for web/tools/precompress_dist.py.  Run: python3 -m unittest web/tests/test_precompress_dist.py -v"""

import gzip
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "precompress_dist.py")


def make_dist(root, contents):
    with open(os.path.join(root, "products.json"), "w") as f:
        json.dump([{"id": "WiiCompiled", "title": "Mario Kart Wii", "glue": "WiiCompiled.js"},
                   {"id": "RetroRewind", "title": "Retro Rewind", "glue": "RetroRewind.js", "modRoot": "mods/RetroRewind6"}], f)
    for name, data in contents.items():
        with open(os.path.join(root, name), "wb") as f:
            f.write(data)


def run_tool(root, *extra):
    return subprocess.run([sys.executable, TOOL, root, "--no-brotli", *extra], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, universal_newlines=True)


def products(root):
    with open(os.path.join(root, "products.json")) as f:
        return json.load(f)


class PrecompressTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        self.base = b"\0asm\1\0\0\0" + b"base game " * 20000
        self.retro = b"\0asm\1\0\0\0" + b"retro rewind " * 20000
        make_dist(self.root, {"WiiCompiled.js": b"//glue", "WiiCompiled.wasm": self.base,
                              "RetroRewind.js": b"//glue", "RetroRewind.wasm": self.retro,
                              "index.html": b"<!doctype html>"})

    def test_hashes_renames_and_records(self):
        result = run_tool(self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        base, retro = products(self.root)
        sha = hashlib.sha256(self.base).hexdigest()[:8]
        self.assertEqual(base["wasm"], "WiiCompiled.%s.wasm" % sha)
        self.assertEqual(base["glue"], "WiiCompiled.js")  # the glue keeps its name
        self.assertEqual(base["wasmSize"], len(self.base))
        self.assertEqual(retro["wasm"], "RetroRewind.%s.wasm" % hashlib.sha256(self.retro).hexdigest()[:8])
        self.assertEqual(retro["modRoot"], "mods/RetroRewind6")
        self.assertFalse(os.path.exists(os.path.join(self.root, "WiiCompiled.wasm")))
        with open(os.path.join(self.root, base["wasm"]), "rb") as f:
            self.assertEqual(f.read(), self.base)
        gz = os.path.join(self.root, base["wasm"] + ".gz")
        with open(gz, "rb") as f:
            packed = f.read()
        self.assertEqual(gzip.decompress(packed), self.base)
        self.assertEqual(base["wasmGzSize"], len(packed))
        self.assertLess(base["wasmGzSize"], base["wasmSize"])
        self.assertNotIn("wasmBrSize", base)  # --no-brotli
        self.assertFalse(os.path.exists(os.path.join(self.root, base["wasm"] + ".br")))

    def test_gzip_is_reproducible(self):
        run_tool(self.root)
        name = products(self.root)[0]["wasm"]
        with open(os.path.join(self.root, name + ".gz"), "rb") as f:
            first = f.read()
        os.rename(os.path.join(self.root, name), os.path.join(self.root, "WiiCompiled.wasm"))
        make_dist(self.root, {})  # fresh products.json without the wasm field
        run_tool(self.root)
        with open(os.path.join(self.root, name + ".gz"), "rb") as f:
            self.assertEqual(f.read(), first)

    def test_rerun_is_idempotent(self):
        run_tool(self.root)
        first = products(self.root)
        result = run_tool(self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(products(self.root), first)

    def test_new_build_removes_stale_hashes(self):
        run_tool(self.root)
        old = products(self.root)[0]["wasm"]
        make_dist(self.root, {"WiiCompiled.wasm": b"\0asm\1\0\0\0" + b"changed " * 5000, "RetroRewind.wasm": self.retro})
        run_tool(self.root)
        new = products(self.root)[0]["wasm"]
        self.assertNotEqual(old, new)
        for suffix in ("", ".gz", ".br"):
            self.assertFalse(os.path.exists(os.path.join(self.root, old + suffix)), old + suffix)
        self.assertTrue(os.path.exists(os.path.join(self.root, new + ".gz")))

    def test_incompressible_wasm_gets_no_gzip(self):
        make_dist(self.root, {"WiiCompiled.wasm": os.urandom(30000)})
        run_tool(self.root)
        base = products(self.root)[0]
        self.assertNotIn("wasmGzSize", base)
        self.assertFalse(os.path.exists(os.path.join(self.root, base["wasm"] + ".gz")))

    def test_missing_wasm_is_an_error(self):
        os.remove(os.path.join(self.root, "RetroRewind.wasm"))
        result = run_tool(self.root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("RetroRewind.wasm", result.stderr)

    def test_brotli_when_available(self):
        try:
            import brotli  # noqa: F401
        except ImportError:
            self.skipTest("brotli module not installed")
        result = subprocess.run([sys.executable, TOOL, self.root, "--brotli-quality", "5"], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        base = products(self.root)[0]
        import brotli

        with open(os.path.join(self.root, base["wasm"] + ".br"), "rb") as f:
            packed = f.read()
        self.assertEqual(brotli.decompress(packed), self.base)
        self.assertEqual(base["wasmBrSize"], len(packed))


if __name__ == "__main__":
    unittest.main()
