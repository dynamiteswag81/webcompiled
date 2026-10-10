#!/usr/bin/env python3
"""Check every pin in web/windows/toolchain.lock.json against the real download.

    python3 -I web/windows/tests/verify-pins.py [--skip-large] [--lock FILE]

For each URL: stream it, compare SHA-256 / SHA-512 and (when known) the size. A host the machine
cannot reach is reported as UNREACHABLE (not as a pass): run this again from a networked PC.
Exit code 0 = every reachable pin matched and nothing was unreachable; 1 = a mismatch;
3 = no mismatch but some pins could not be reached.
"""
import hashlib
import json
import os
import sys
import urllib.request

here = os.path.dirname(os.path.abspath(__file__))
lock_path = os.path.join(os.path.dirname(here), "toolchain.lock.json")
skip_large = "--skip-large" in sys.argv
if "--lock" in sys.argv:
    lock_path = sys.argv[sys.argv.index("--lock") + 1]
lock = json.load(open(lock_path))


def entries():
    for t in lock["tools"]:
        if t.get("kind") == "emsdk":
            for f in t["files"]:
                yield "emsdk/" + f["name"], f
            for p in t["packages"]:
                yield "emsdk/" + p["name"], p
        else:
            yield t["id"], t
    for k, v in lock.get("fallbacks", {}).items():
        yield "fallback/" + k, v


status = 0
unreachable = 0
for name, e in entries():
    size_known = e.get("size", 0)
    if skip_large and size_known > 100 * 1024 * 1024:
        print(f"SKIP         {name} ({size_known // 1024 // 1024} MB)")
        continue
    h256, h512 = hashlib.sha256(), hashlib.sha512()
    n = 0
    try:
        req = urllib.request.Request(e["url"], headers={"User-Agent": "WiiCompiled-verify-pins"})
        with urllib.request.urlopen(req, timeout=60) as r:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                h256.update(b)
                h512.update(b)
                n += len(b)
    except Exception as ex:  # noqa: BLE001
        print(f"UNREACHABLE  {name}: {ex}")
        unreachable += 1
        continue
    problems = []
    if e.get("sha256") and h256.hexdigest() != e["sha256"]:
        problems.append(f"sha256 {h256.hexdigest()} != {e['sha256']}")
    if e.get("sha512") and h512.hexdigest() != e["sha512"]:
        problems.append("sha512 differs")
    if size_known and n != size_known:
        problems.append(f"size {n} != {size_known}")
    if not (e.get("sha256") or e.get("sha512")):
        problems.append("no hash pinned")
    if problems:
        status = 1
        print(f"MISMATCH     {name}: " + "; ".join(problems))
    else:
        algos = "+".join(a for a in ("sha256", "sha512") if e.get(a))
        print(f"OK           {name} ({n} bytes, {algos})")

if status == 0 and unreachable:
    status = 3
sys.exit(status)
