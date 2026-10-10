#!/usr/bin/env python3
"""Build a game-data-free `generated/` tree for the web product smoke test.

The real product links ~427 MB of C++ that the translator emits from the user's disc. This
script runs the REAL translator pipeline (translate-recursive, generate-data-init,
emit-build-shards; emit-base-manifest only feeds Retro Rewind and needs a REL, so it is skipped)
on a tiny synthetic DOL instead, so the web build
consumes exactly the file shapes the translator produces (shards.cmake, registration and
dispatch TUs, data_sections_init.cpp + #embed blob companion, guest_symbol_table.cpp,
RuntimeConfig.h) without any game data.

The synthetic DOL contains nothing from any game. Its only code is a stand-in for the
product entry point (0x800060A4, system_bridge.h kDefaultEntryAddress). With --frames N (the
default is 600) it first runs a frame loop through the runtime's own GX/VI HLE: GXInit
(0x8016B850) once, then N x GXCopyDisp (0x8016FC38), each of which seals, presents and paces
one Aurora frame to the VI retrace grid exactly like the game's frame boundary (the smoke test
hides and shows the page during this loop). Then it does what the real boot path does before
it first needs the disc: it calls DVDInit (0x8015EA1C), which the runtime overrides natively and
which resolves the DVD root. With no disc configured, that is where startup stops with the
runtime's own "DVD data is unavailable" fatal report.

The runtime also calls a few translated originals directly by symbol (`extern "C" void
func_XXXXXXXX(CpuContext*)`, e.g. the guest bodies behind REGISTER_NATIVE_FUNCTION_AS wrappers).
Those addresses are scanned from runtime/ and get a one-instruction `blr` body in the synthetic
DOL plus a function-map entry, so the translator emits a real func_XXXXXXXX for each and the
product links without undefined-symbol stubs. None of them run before the DVD stop.

Usage: make_synthetic_generated.py OUT_DIR [--translator DLL] [--workspace REPO]
Produces OUT_DIR/generated/... (pass OUT_DIR to cmake as MKW_GENERATED_ROOT).
"""

from __future__ import annotations

import argparse
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path

ENTRY = 0x800060A4      # runtime/include/system_bridge.h kDefaultEntryAddress
DVD_INIT = 0x8015EA1C   # runtime/src/hle/storage/dvd.cpp PPC_NATIVE_OVERRIDE_VOID(8015EA1C, DVDInit...)
GX_INIT = 0x8016B850    # runtime/src/hle/gx/gx_init.cpp GX__Init_8016b850(fifoBase, fifoSize)
GX_COPY_DISP = 0x8016FC38  # runtime/src/hle/gx/gx_copy.cpp GX__CopyDisp_8016fc38(xfb, clear)
FIFO_BASE = 0x80400000  # 256 KiB GX FIFO for the frame loop (free MEM1; nothing else lives there)
FIFO_SIZE = 0x00040000
XFB_ADDR = 0x80500000   # "external framebuffer" address handed to GXCopyDisp (never read back)
DATA_ADDR = 0x80300000
SDA_BASE = 0x8038CC00
SDA2_BASE = 0x8038EFA0


def bl(pc: int, target: int) -> int:
    return 0x48000001 | ((target - pc) & 0x03FFFFFC)


def entry_code(frames: int) -> list[int]:
    if not 0 <= frames <= 0x7FFF:
        raise SystemExit("--frames must be 0..32767")
    words: list[object] = [
        0x9421FFE0,  # stwu  r1,-32(r1)
        0x7C0802A6,  # mflr  r0
        0x90010024,  # stw   r0,36(r1)
        0x93E1001C,  # stw   r31,28(r1)
    ]
    if frames:
        words += [
            0x3C600000 | (FIFO_BASE >> 16),   # lis   r3,FIFO_BASE@h
            0x3C800000 | (FIFO_SIZE >> 16),   # lis   r4,FIFO_SIZE@h
            ("bl", GX_INIT),
            0x3BE00000 | frames,              # li    r31,frames
            "loop",
            0x3C600000 | (XFB_ADDR >> 16),    # lis   r3,XFB_ADDR@h
            0x38800001,                       # li    r4,1 (clear)
            ("bl", GX_COPY_DISP),
            0x37FFFFFF,                       # addic. r31,r31,-1
            ("bne", "loop"),
        ]
    words += [
        ("bl", DVD_INIT),
        0x83E1001C,  # lwz   r31,28(r1)
        0x80010024,  # lwz   r0,36(r1)
        0x7C0803A6,  # mtlr  r0
        0x38210020,  # addi  r1,r1,32
        0x38600000,  # li    r3,0
        0x4E800020,  # blr
    ]
    labels: dict[str, int] = {}
    pc = ENTRY
    for word in words:
        if isinstance(word, str):
            labels[word] = pc
        else:
            pc += 4
    out: list[int] = []
    pc = ENTRY
    for word in words:
        if isinstance(word, str):
            continue
        if isinstance(word, tuple) and word[0] == "bl":
            out.append(bl(pc, word[1]))
        elif isinstance(word, tuple) and word[0] == "bne":
            out.append(0x40820000 | ((labels[word[1]] - pc) & 0xFFFC))  # bne cr0,label
        else:
            out.append(word)
        pc += 4
    return out


BLR = 0x4E800020
RUNTIME_FUNC_RE = re.compile(r'extern\s+"C"\s+void\s+func_([0-9A-Fa-f]{8})\s*\(')


def runtime_referenced_functions(workspace: Path) -> list[int]:
    """Guest functions the runtime calls by their translated symbol name."""
    found: set[int] = set()
    for root in (workspace / "runtime" / "src", workspace / "runtime" / "include"):
        for path in root.rglob("*"):
            if path.suffix in (".cpp", ".h", ".hpp", ".inl") and path.is_file():
                for match in RUNTIME_FUNC_RE.finditer(path.read_text(errors="replace")):
                    found.add(int(match.group(1), 16))
    return sorted(found)


def text_sections(functions: dict[int, bytes], slots: int = 7) -> list[tuple[int, bytes]]:
    """Pack function bodies into at most `slots` DOL text sections (gaps are zero-filled)."""
    clusters = [[addr] for addr in sorted(functions)]
    end = lambda c: c[-1] + len(functions[c[-1]])
    while len(clusters) > slots:
        i = min(range(len(clusters) - 1), key=lambda k: clusters[k + 1][0] - end(clusters[k]))
        clusters[i:i + 2] = [clusters[i] + clusters[i + 1]]
    sections = []
    for cluster in clusters:
        base = cluster[0]
        blob = bytearray(end(cluster) - base)
        for addr in cluster:
            blob[addr - base:addr - base + len(functions[addr])] = functions[addr]
        blob += bytes((-len(blob)) % 32)
        sections.append((base, bytes(blob)))
    return sections


def make_dol(extra_functions: list[int], frames: int) -> bytes:
    """DOL layout: 0x100-byte header, then section payloads (see translator SyntheticDolFactory)."""
    words = lambda ws: b"".join(struct.pack(">I", w) for w in ws)
    functions = {addr: words([BLR]) for addr in extra_functions}
    functions[ENTRY] = words(entry_code(frames))
    # Bodies for the natively overridden callees: the translator never lifts them, but the target
    # of a direct call must lie inside a text section.
    for native in (DVD_INIT, GX_INIT, GX_COPY_DISP):
        functions[native] = words([BLR])
    text = text_sections(functions)
    if len(text) > 7:
        raise SystemExit("synthetic DOL needs more than 7 text sections")
    payload = b"WiiCompiled web smoke test: synthetic data section (no game data).\0"
    payload += bytes((-len(payload)) % 32)
    data = [(DATA_ADDR, payload)]

    text_off, text_addr, text_size = [0] * 7, [0] * 7, [0] * 7
    data_off, data_addr, data_size = [0] * 11, [0] * 11, [0] * 11
    blobs = bytearray()
    offset = 0x100
    for slot, (addr, blob) in enumerate(text):
        text_off[slot], text_addr[slot], text_size[slot] = offset, addr, len(blob)
        blobs += blob
        offset += len(blob)
    for slot, (addr, blob) in enumerate(data):
        data_off[slot], data_addr[slot], data_size[slot] = offset, addr, len(blob)
        blobs += blob
        offset += len(blob)

    header = bytearray(0x100)
    struct.pack_into(">7I", header, 0x00, *text_off)
    struct.pack_into(">11I", header, 0x1C, *data_off)
    struct.pack_into(">7I", header, 0x48, *text_addr)
    struct.pack_into(">11I", header, 0x64, *data_addr)
    struct.pack_into(">7I", header, 0x90, *text_size)
    struct.pack_into(">11I", header, 0xAC, *data_size)
    struct.pack_into(">III", header, 0xD8, DATA_ADDR + 0x1000, 0x1000, ENTRY)  # bss addr/size, entry
    return bytes(header + blobs)


def project_yaml(workspace: Path, out: Path) -> str:
    return f"""schema_version: 1
workspace_root: {out.as_posix()}

project:
  id: web-smoke-synthetic
  display_name: Web smoke test (synthetic DOL)

memory:
  base: 0x80000000
  size: 0x01A00000
  sda_base: 0x{SDA_BASE:08X}
  sda2_base: 0x{SDA2_BASE:08X}

inputs:
  dol:
    path: {(out / 'input' / 'main.dol').as_posix()}

translation:
  entry_points:
    - 0x{ENTRY:08X}
  function_map:
    path: {(out / 'input' / 'MAP.txt').as_posix()}
  allow_unsupported_instructions: false

runtime:
  native_registration_root: {(workspace / 'runtime' / 'src').as_posix()}
  native_abi_directories:
    - {(workspace / 'runtime' / 'src' / 'hle' / 'gx').as_posix()}

output:
  root: {(out / 'generated').as_posix()}
  functions: functions
  runtime_config: RuntimeConfig.h
  data_initializer: data_sections_init.cpp
  base_manifest: {(out / 'base' / 'base_manifest.json').as_posix()}
"""


def main() -> int:
    repo = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--workspace", type=Path, default=repo)
    parser.add_argument("--frames", type=int, default=600,
                        help="GXCopyDisp frames the entry point presents before DVDInit (0: none)")
    parser.add_argument("--translator", type=Path,
                        default=repo / "translator/src/Translator.Cli/bin/Release/net8.0/Translator.Cli.dll")
    args = parser.parse_args()

    out = args.out_dir.resolve()
    workspace = args.workspace.resolve()
    # Keep translator output out of tracked paths: outside the repo, or under the gitignored
    # /build/ tree. (Not /generated/ itself: that is where a real translation lives.)
    if out == workspace or workspace in out.parents:
        rel = out.relative_to(workspace).parts
        if not rel or rel[0] != "build":
            parser.error(f"{out} is inside the repository but not under its gitignored build/")
    if not args.translator.is_file():
        subprocess.run(["dotnet", "build", str(workspace / "translator/src/Translator.Cli/Translator.Cli.csproj"),
                        "-c", "Release", "-m:2"], check=True)

    for sub in ("generated", "base", "input"):
        shutil.rmtree(out / sub, ignore_errors=True)
    (out / "input").mkdir(parents=True)
    extra = [addr for addr in runtime_referenced_functions(workspace)
             if addr not in (ENTRY, DVD_INIT, GX_INIT, GX_COPY_DISP)]
    print("runtime-referenced translated functions: " + ", ".join(f"func_{a:08X}" for a in extra))
    print(f"entry point frame loop: {args.frames} GXCopyDisp frame(s) before DVDInit")
    (out / "input" / "main.dol").write_bytes(make_dol(extra, args.frames))
    (out / "input" / "MAP.txt").write_text(
        f"{ENTRY:08x} smoke_entry\n" + "".join(f"{a:08x} runtime_ref_{a:08x}\n" for a in extra))
    project = out / "input" / "recomp.yml"
    project.write_text(project_yaml(workspace, out))

    generated = out / "generated"
    functions = generated / "functions"
    metadata = generated / "base_translation_output.json"

    def translator(*cmd: str) -> None:
        full = ["dotnet", str(args.translator), *cmd, "--project", str(project)]
        print("+", " ".join(full), flush=True)
        subprocess.run(full, check=True, cwd=out)

    translator("translate-recursive", f"0x{ENTRY:08X}", "--outdir", str(functions),
               "--output-metadata", str(metadata),
               "--production-source-bundle", str(generated / "base_translation_sources.bin"),
               "--no-function-files", "--prune-stale", "--threads", "1")
    # emit-base-manifest is skipped: it describes the base for Retro Rewind mod translation and
    # needs a StaticR.rel; the base product graph does not consume it.
    translator("generate-data-init")
    translator("emit-build-shards", "--base-metadata", str(metadata), "--base-functions-dir", str(functions),
               "--native-source-dir", str(workspace / "runtime" / "src"),
               "--out", str(generated / "build_shards"))

    manifest = generated / "build_shards" / "shards.cmake"
    for required in (manifest, generated / "RuntimeConfig.h", generated / "data_sections_init.cpp",
                     generated / "data_sections_init_blobs.cpp"):
        if not required.is_file():
            print(f"error: translator did not produce {required}", file=sys.stderr)
            return 1
    print(f"synthetic generated tree: {generated}")
    print(f"shard manifest: {manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
