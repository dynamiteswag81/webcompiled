#!/usr/bin/env python3
"""Make the wasm files of a web/dist site cacheable and precompressed (Python 3 standard library).

    python3 web/tools/precompress_dist.py DIST [--brotli-quality N] [--no-brotli]

Run by web/build.sh and web/build.ps1 after products.json is written. For every product in
products.json (its glue "X.js" names the wasm "X.wasm"):

  * renames X.wasm to X.<sha8>.wasm, where <sha8> is the first 8 hex digits of its SHA-256, so a
    server can send `Cache-Control: immutable` for it (the file name changes whenever the content
    does). Older hashed copies of the same product are deleted.
  * writes X.<sha8>.wasm.gz (gzip -9, reproducible) and, when the `brotli` Python module or a
    `brotli` command is available, X.<sha8>.wasm.br. Servers with precompressed-file support
    (nginx gzip_static/brotli_static, Caddy file_server precompressed, web/serve.py) send these
    with Content-Encoding. The .gz/.br are dropped again when they do not make the file smaller.
  * records in products.json: "wasm" (the hashed name), "wasmSize" (raw bytes), "wasmGzSize" and
    "wasmBrSize" (compressed bytes, when written). The glue .js keeps its name; the page reads
    "wasm" to know what to fetch and uses the sizes for its progress bar.

Running it twice is safe: an entry that already has a "wasm" field whose file exists is kept.
"""

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

HASH_LEN = 8
CHUNK = 1 << 20


def sha256_prefix(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(CHUNK)
            if not block:
                break
            h.update(block)
    return h.hexdigest()[:HASH_LEN]


def write_gzip(src, dest):
    # mtime=0 and no filename: the same input always gives the same bytes (stable ETags/rsync).
    with open(src, "rb") as fin, open(dest, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as fout:
            shutil.copyfileobj(fin, fout, CHUNK)


def brotli_module():
    try:
        import brotli  # type: ignore

        return brotli
    except ImportError:
        return None


def write_brotli(src, dest, quality):
    """Writes dest and returns True, or returns False when no brotli encoder is available."""
    module = brotli_module()
    if module is not None:
        compressor = module.Compressor(quality=quality, lgwin=24)
        with open(src, "rb") as fin, open(dest, "wb") as fout:
            while True:
                block = fin.read(CHUNK)
                if not block:
                    break
                fout.write(compressor.process(block))
            fout.write(compressor.finish())
        return True
    exe = shutil.which("brotli")
    if exe:
        result = subprocess.run([exe, "-q", str(quality), "-f", "-o", dest, src],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if result.returncode == 0:
            return True
        sys.stderr.write("precompress_dist: brotli command failed: %s\n" % result.stderr.decode("utf8", "replace").strip())
        if os.path.exists(dest):
            os.remove(dest)
    return False


def remove_quietly(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def process_product(dist, product, brotli_quality, use_brotli, log):
    glue = product.get("glue", "")
    if not glue.endswith(".js"):
        return
    target = glue[:-3]
    plain = target + ".wasm"
    plain_path = os.path.join(dist, plain)

    existing = product.get("wasm")
    if existing and os.path.isfile(os.path.join(dist, existing)) and not os.path.isfile(plain_path):
        hashed = existing  # already processed, only refresh the siblings and sizes
    else:
        if not os.path.isfile(plain_path):
            raise SystemExit("precompress_dist: %s not found in %s" % (plain, dist))
        hashed = "%s.%s.wasm" % (target, sha256_prefix(plain_path))
        hashed_path = os.path.join(dist, hashed)
        if os.path.exists(hashed_path):
            os.remove(hashed_path)
        os.replace(plain_path, hashed_path)
    hashed_path = os.path.join(dist, hashed)

    # Stale hashed builds of this product (and their compressed siblings).
    pattern = re.compile(r"^%s\.[0-9a-f]{%d}\.wasm(\.gz|\.br)?$" % (re.escape(target), HASH_LEN))
    for name in os.listdir(dist):
        if pattern.match(name) and not name.startswith(hashed):
            os.remove(os.path.join(dist, name))
            log("removed stale %s" % name)

    raw_size = os.path.getsize(hashed_path)
    product["wasm"] = hashed
    product["wasmSize"] = raw_size
    for key in ("wasmGzSize", "wasmBrSize"):
        product.pop(key, None)

    gz_path = hashed_path + ".gz"
    write_gzip(hashed_path, gz_path)
    gz_size = os.path.getsize(gz_path)
    if gz_size < raw_size:
        product["wasmGzSize"] = gz_size
    else:
        os.remove(gz_path)

    br_path = hashed_path + ".br"
    remove_quietly(br_path)
    br_size = 0
    if use_brotli and write_brotli(hashed_path, br_path, brotli_quality):
        br_size = os.path.getsize(br_path)
        if br_size < raw_size:
            product["wasmBrSize"] = br_size
        else:
            os.remove(br_path)
            br_size = 0

    mib = lambda n: "%.1f MiB" % (n / 1048576)
    log("%s: %s raw, %s gzip%s" % (
        hashed, mib(raw_size), mib(product["wasmGzSize"]) if "wasmGzSize" in product else "no gzip gain",
        (", %s brotli" % mib(br_size)) if br_size else (", no brotli (install the 'brotli' Python module or command)" if use_brotli else "")))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Hash-name and precompress the wasm files of a web/dist site.")
    ap.add_argument("dist", help="the site directory (contains products.json)")
    ap.add_argument("--brotli-quality", type=int, default=11, help="brotli quality 0-11 (default 11, slow but smallest)")
    ap.add_argument("--no-brotli", action="store_true", help="only write .gz")
    ap.add_argument("-q", "--quiet", action="store_true")
    args = ap.parse_args(argv)

    def log(message):
        if not args.quiet:
            print("  precompress: " + message)

    products_path = os.path.join(args.dist, "products.json")
    if not os.path.isfile(products_path):
        print("precompress_dist: error: no products.json in %s" % args.dist, file=sys.stderr)
        return 1
    with open(products_path, "r", encoding="utf8") as f:
        products = json.load(f)
    if not isinstance(products, list) or not products:
        print("precompress_dist: error: products.json is not a non-empty list", file=sys.stderr)
        return 1
    for product in products:
        process_product(args.dist, product, args.brotli_quality, not args.no_brotli, log)
    tmp = products_path + ".tmp"
    with open(tmp, "w", encoding="utf8", newline="\n") as f:
        json.dump(products, f, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, products_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
