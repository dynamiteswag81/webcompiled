#!/usr/bin/env python3
"""Build the prebuilt package of the web build's libraries without game content.

Maintainer tool. Compiles aurora, SDL3, abseil, zstd, libpng, freetype, imgui,
Crypto++ and the rest of aurora's closure for wasm once, and packages the
archives plus a CMake description (web_prebuilt.cmake) that
runtime/cmake/WebPrebuilt.cmake imports with -DMKW_WEB_PREBUILT_DIR=<dir>. A host
then only compiles the runtime and the translated game.

The package never contains translated game code or anything derived from a disc:
the staging configure has MKW_BUILD_PRODUCTS=OFF, so no translator output is
even read.

How the interface is found: runtime/cmake/WebPrebuiltExport.cmake adds a probe
executable linking aurora::gx/pad/si/vi/mtx + Crypto++ and an identical control
executable linking nothing. Subtracting the control's resolved compile and link
command lines (from build.ninja) from the probe's leaves exactly what those
targets contribute (the native harvest, Launcher/Prepare-NativePrebuilt.sh,
works the same way).

Usage:
  source /opt/emsdk/emsdk_env.sh
  python3 web/tools/make_web_prebuilt.py [--stage DIR] [--out DIR] [--jobs N]
      [--archive web/prebuilt/web-prebuilt.tar.xz] [--cmake-arg ARG ...]
"""

import argparse
import hashlib
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[2]
RUNTIME = WORKSPACE / "runtime"
AURORA = WORKSPACE / "aurora-main"

# Must match mkw_web_prebuilt_fingerprint() in runtime/cmake/WebPrebuilt.cmake.
FINGERPRINT_SUFFIXES = (".c", ".cpp", ".h", ".hpp", ".cmake", ".txt", ".mm", ".inc", ".asm", ".S")
HEADER_SUFFIXES = (".h", ".hh", ".hpp", ".hxx", ".inc", ".inl", ".ipp", ".tcc", ".def")


def fail(message):
    print(f"make_web_prebuilt: error: {message}", file=sys.stderr)
    sys.exit(1)


def source_fingerprint(emscripten_version):
    lines = []
    for label, root in (("aurora-main", AURORA), ("cryptopp", RUNTIME / "third_party" / "cryptopp")):
        files = []
        for path in root.rglob("*"):
            if not path.is_file() or not path.name.endswith(FINGERPRINT_SUFFIXES):
                continue
            relative = path.relative_to(root).as_posix()
            if re.match(r"^build[^/]*/", relative):
                continue
            files.append(relative)
        for relative in sorted(files):
            content = (root / relative).read_bytes().replace(b"\r\n", b"\n")
            lines.append(f"{label}/{relative} {hashlib.sha256(content).hexdigest()}\n")
    content = (RUNTIME / "CMakeLists.txt").read_bytes().replace(b"\r\n", b"\n")
    lines.append(f"runtime/CMakeLists.txt {hashlib.sha256(content).hexdigest()}\n")
    lines.append(f"emscripten {emscripten_version}\n")
    return hashlib.sha256("".join(lines).encode()).hexdigest()


def ninja_statement_vars(build_ninja, rule):
    """Variables of the first `build ...: <rule> ...` statement, ninja-unescaped."""
    variables = {}
    in_statement = False
    for line in build_ninja.read_text().splitlines():
        if line.startswith("build "):
            if in_statement:
                break
            head = line.split(": ", 1)
            if len(head) == 2 and head[1].split(" ", 1)[0] == rule:
                in_statement = True
            continue
        if in_statement:
            if not line.startswith("  ") or " = " not in line:
                break
            key, value = line[2:].split(" = ", 1)
            variables[key] = value.replace("$ ", " ").replace("$:", ":").replace("$$", "$")
    if not in_statement:
        fail(f"no build statement uses the Ninja rule {rule}")
    return variables


def subtract(probe, control):
    """Multiset difference preserving the probe's order (static link order matters)."""
    pending = {}
    for item in control:
        pending[item] = pending.get(item, 0) + 1
    result = []
    for item in probe:
        if pending.get(item, 0) > 0:
            pending[item] -= 1
            continue
        result.append(item)
    return result


def parse_includes(tokens):
    directories = []
    iterator = iter(tokens)
    for token in iterator:
        if token in ("-I", "-isystem", "-iquote", "-idirafter"):
            directories.append(next(iterator))
        elif token.startswith("-isystem"):
            directories.append(token[len("-isystem"):])
        elif token.startswith("-I"):
            directories.append(token[2:])
        else:
            fail(f"unexpected include token: {token}")
    return directories


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stage", default=str(WORKSPACE / "build" / "web-prebuilt-stage"))
    parser.add_argument("--out", default=str(WORKSPACE / "build" / "web-prebuilt"))
    parser.add_argument("--archive", default=str(WORKSPACE / "web" / "prebuilt" / "web-prebuilt.tar.xz"))
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    parser.add_argument("--cmake-arg", action="append", default=[],
                        help="extra configure argument (repeatable), e.g. FETCHCONTENT_SOURCE_DIR_* overrides")
    parser.add_argument("--reuse-stage", action="store_true", help="keep an existing staging build")
    args = parser.parse_args()

    stage = Path(args.stage).resolve()
    out = Path(args.out).resolve()
    export = stage / "export"
    if shutil.which("emcmake") is None:
        fail("emcmake is not on PATH (source emsdk_env.sh first)")
    if not args.reuse_stage and stage.exists():
        shutil.rmtree(stage)
    export.mkdir(parents=True, exist_ok=True)

    # Static everything; vendored providers only, so a maintainer machine's system packages
    # cannot leak into the package (same reasoning as Launcher/Prepare-NativePrebuilt.sh).
    configure = [
        "emcmake", "cmake", "-S", str(RUNTIME), "-B", str(stage), "-G", "Ninja",
        "-DCMAKE_BUILD_TYPE=Release", "-DMKW_BUILD_PRODUCTS=OFF", "-DBUILD_SHARED_LIBS=OFF",
        "-DAURORA_SDL3_PROVIDER=vendor",
        "-DCMAKE_DISABLE_FIND_PACKAGE_absl=ON", "-DCMAKE_DISABLE_FIND_PACKAGE_PNG=ON",
        "-DCMAKE_DISABLE_FIND_PACKAGE_Freetype=ON", "-DFT_DISABLE_BZIP2=ON",
        f"-DMKW_WEB_PREBUILT_EXPORT_DIR={export}",
    ]
    configure += [item for arg in args.cmake_arg for item in shlex.split(arg)]
    print("make_web_prebuilt: configuring the staging build")
    subprocess.run(configure, check=True)
    print("make_web_prebuilt: building aurora and its libraries")
    subprocess.run(["cmake", "--build", str(stage), "--target", "mkw_wp_probe", "--parallel", str(args.jobs)],
                   check=True)

    meta = dict(line.split("=", 1) for line in (export / "meta.txt").read_text().splitlines() if "=" in line)
    emscripten_version = meta["emscripten_version"]
    binary_dir = Path(meta["binary_dir"]).resolve()

    build_ninja = stage / "build.ninja"
    probe_compile = ninja_statement_vars(build_ninja, "CXX_COMPILER__mkw_wp_probe_unscanned_Release")
    control_compile = ninja_statement_vars(build_ninja, "CXX_COMPILER__mkw_wp_probe_control_unscanned_Release")
    probe_link = ninja_statement_vars(build_ninja, "CXX_EXECUTABLE_LINKER__mkw_wp_probe_Release")
    control_link = ninja_statement_vars(build_ninja, "CXX_EXECUTABLE_LINKER__mkw_wp_probe_control_Release")

    def diff(key, probe, control):
        return subtract(shlex.split(probe.get(key, "")), shlex.split(control.get(key, "")))

    include_dirs = parse_includes(diff("INCLUDES", probe_compile, control_compile))
    defines = [token[2:] for token in diff("DEFINES", probe_compile, control_compile)]
    compile_options = diff("FLAGS", probe_compile, control_compile)
    link_items = diff("LINK_LIBRARIES", probe_link, control_link)
    link_options = diff("LINK_FLAGS", probe_link, control_link)
    if not include_dirs or not link_items:
        fail("the probe did not pick up aurora's interface")

    if out.exists():
        shutil.rmtree(out)
    (out / "lib").mkdir(parents=True)
    (out / "include").mkdir()

    def tokenize_include(directory):
        path = Path(directory)
        if not path.is_absolute():
            path = (stage / path)
        path = path.resolve()
        for token, root in (("@AURORA@", AURORA), ("@RUNTIME@", RUNTIME)):
            try:
                return f"{token}/{path.relative_to(root).as_posix()}"
            except ValueError:
                pass
        # Fetched sources and generated headers live outside the checkout: ship their headers.
        index = len(list((out / "include").iterdir())) + 1
        destination = out / "include" / f"inc{index:02d}"
        copied = 0
        for source in path.rglob("*"):
            if source.is_file() and (source.suffix in HEADER_SUFFIXES or "." not in source.name and
                                     source.parent.name in ("c++", "include")):
                target = destination / source.relative_to(path)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                copied += 1
        destination.mkdir(parents=True, exist_ok=True)
        print(f"  include {path} -> @PKG@/include/{destination.name} ({copied} headers)")
        return f"@PKG@/include/{destination.name}"

    include_tokens = []
    for directory in include_dirs:
        token = tokenize_include(directory)
        if token not in include_tokens:
            include_tokens.append(token)

    link_tokens = []
    for item in link_items:
        if item.startswith("-") or not item.endswith(".a"):
            link_tokens.append(item)  # flags such as --use-port=emdawnwebgpu or -lfoo
            continue
        path = Path(item)
        if not path.is_absolute():
            path = binary_dir / path
        path = path.resolve()
        if not path.is_file():
            fail(f"link input missing: {path}")
        name = path.name
        if (out / "lib" / name).exists():
            if (out / "lib" / name).read_bytes() != path.read_bytes():
                fail(f"two different archives share the name {name}")
        else:
            shutil.copy2(path, out / "lib" / name)
        link_tokens.append(f"@PKG@/lib/{name}")
    if not (out / "lib" / "libmkw_cryptopp.a").exists():
        fail("libmkw_cryptopp.a was not part of the harvested closure")

    fingerprint = source_fingerprint(emscripten_version)

    def cmake_list(values):
        return "\n".join(f'    "{value.replace(chr(34), chr(92) + chr(34))}"' for value in values)

    (out / "web_prebuilt.cmake").write_text(
        "# Generated by web/tools/make_web_prebuilt.py; consumed by runtime/cmake/WebPrebuilt.cmake.\n"
        "# Libraries without game content only (aurora and its dependencies, Crypto++).\n"
        f'set(MKW_WP_EMSCRIPTEN_VERSION "{emscripten_version}")\n'
        f'set(MKW_WP_SOURCE_FINGERPRINT "{fingerprint}")\n'
        f"set(MKW_WP_INCLUDE_DIRECTORIES\n{cmake_list(include_tokens)})\n"
        f"set(MKW_WP_COMPILE_DEFINITIONS\n{cmake_list(defines)})\n"
        f"set(MKW_WP_COMPILE_OPTIONS\n{cmake_list(compile_options)})\n"
        f"set(MKW_WP_LINK_LIBRARIES\n{cmake_list(link_tokens)})\n"
        f"set(MKW_WP_LINK_OPTIONS\n{cmake_list(link_options)})\n")

    archive = Path(args.archive).resolve()
    archive.parent.mkdir(parents=True, exist_ok=True)

    def reset(info):
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        info.mtime = 0
        return info

    with tarfile.open(archive, "w:xz", preset=9) as tar:
        for path in sorted(out.rglob("*")):
            tar.add(path, arcname=f"web-prebuilt/{path.relative_to(out).as_posix()}", recursive=False, filter=reset)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (archive.parent / (archive.name + ".sha256")).write_text(f"{digest}  {archive.name}\n")
    size = archive.stat().st_size
    print(f"make_web_prebuilt: {len(link_tokens)} link inputs, {len(include_tokens)} include dirs")
    print(f"make_web_prebuilt: wrote {archive} ({size / 1048576:.1f} MiB, sha256 {digest})")
    print(f"make_web_prebuilt: package directory {out}; fingerprint {fingerprint}")


if __name__ == "__main__":
    main()
