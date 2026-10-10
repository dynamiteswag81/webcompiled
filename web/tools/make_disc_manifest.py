#!/usr/bin/env python3
"""Write the disc manifest the web build reads instead of scanning the disc root.

Usage: python3 web/tools/make_disc_manifest.py <disc_root> <out.json>

<disc_root> is an extracted DATA partition (it contains `sys/fst.bin` and `files/`), normally
already copied to `web/dist/disc/`; <out.json> is normally `web/dist/disc-manifest.json`.

Format (version 1, UTF-8 JSON):
  {
    "format": "wiicompiled-disc-manifest",
    "version": 1,
    "root": "disc/",                   # disc tree URL, relative to the manifest's own URL
    "fileCount": 1234,
    "totalBytes": 4321,
    "files": {"files/Race/Course/x.szs": 123456, "sys/fst.bin": 4096, ...},
    "directories": ["files", "files/Race", ...]
  }
Paths are relative to <disc_root>, use '/' separators and keep the on-disk case; `files` maps
every regular file to its size in bytes; `directories` lists every directory (including empty
ones), parents before children. Entries are sorted, so the output is deterministic.
"""

import json
import os
import sys
import urllib.parse

FORMAT = "wiicompiled-disc-manifest"
VERSION = 1
MAX_FILE_SIZE = 0xFFFFFFFF  # DVD file sizes are 32-bit


def fail(message):
    print(f"make_disc_manifest: error: {message}", file=sys.stderr)
    sys.exit(1)


def walk(disc_root):
    files = {}
    directories = []

    def onerror(error):
        fail(f"cannot read {error.filename}: {error.strerror}")

    for current, dirnames, filenames in os.walk(disc_root, onerror=onerror, followlinks=True):
        dirnames.sort()
        rel_dir = os.path.relpath(current, disc_root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")
        if rel_dir:
            directories.append(rel_dir)
        for name in sorted(filenames):
            full = os.path.join(current, name)
            if not os.path.isfile(full):
                continue  # dangling symlink, socket, ...
            rel = f"{rel_dir}/{name}" if rel_dir else name
            if any(ch in rel for ch in "\t\n\r\0\\"):
                fail(f"unsupported character in path {rel!r}")
            size = os.path.getsize(full)
            if size > MAX_FILE_SIZE:
                fail(f"{rel} is larger than 4 GiB ({size} bytes)")
            files[rel] = size
    return dict(sorted(files.items())), sorted(directories)


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    disc_root, out_path = argv[1], argv[2]
    if not os.path.isdir(disc_root):
        fail(f"{disc_root} is not a directory")
    if not os.path.isfile(os.path.join(disc_root, "sys", "fst.bin")) or \
            not os.path.isdir(os.path.join(disc_root, "files")):
        fail(f"{disc_root} is not an extracted DATA partition (expected sys/fst.bin and files/)")

    files, directories = walk(disc_root)

    out_dir = os.path.dirname(os.path.abspath(out_path))
    try:
        root = os.path.relpath(os.path.abspath(disc_root), out_dir).replace(os.sep, "/")
    except ValueError:  # different drives on Windows
        root = "disc"
    root = "./" if root == "." else urllib.parse.quote(root.rstrip("/")) + "/"
    if root.startswith("../"):
        print(f"make_disc_manifest: warning: the disc tree is outside the manifest's directory "
              f"(root {root!r}); the site must serve it at that relative URL", file=sys.stderr)

    manifest = {
        "format": FORMAT,
        "version": VERSION,
        "root": root,
        "fileCount": len(files),
        "totalBytes": sum(files.values()),
        "files": files,
        "directories": directories,
    }
    os.makedirs(out_dir, exist_ok=True)
    temp_path = out_path + ".tmp"
    with open(temp_path, "w", encoding="utf-8", newline="\n") as out:
        json.dump(manifest, out, ensure_ascii=False, indent=1)
        out.write("\n")
    os.replace(temp_path, out_path)
    print(f"make_disc_manifest: {len(files)} files, {len(directories)} directories, "
          f"{manifest['totalBytes']} bytes -> {out_path} (root {root!r})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
