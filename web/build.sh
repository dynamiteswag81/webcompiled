#!/usr/bin/env bash
# WiiCompiled for the Web - operator pipeline (Linux / macOS).
#
#   web/build.sh /path/to/mkwii-pal.iso [--out DIR] [--build-dir DIR] [--jobs N] [--skip-translate]
#
# Takes the operator's own PAL (RMCP01) Mario Kart Wii disc image, extracts it, runs the same
# translator pipeline as Launcher/local-build.sh, compiles the runtime + translated code to
# WebAssembly with Emscripten, and writes a self-contained static site (default web/dist/).
# Any static web server with HTTP Range support can host that directory; `web/serve.py` is a
# small one for local testing. The repository itself never contains game data.
#
# Windows: use web/build.ps1 (same options).
set -euo pipefail

# ---------------------------------------------------------------------------
# Settings you may want to adjust (names of the CMake target and its outputs).
# ---------------------------------------------------------------------------
WEB_TARGET=WiiCompiled          # CMake target that links the web product
WEB_JS_NAME=WiiCompiled.js      # Emscripten glue emitted by that target (in the build dir)
WEB_WASM_NAME=WiiCompiled.wasm  # wasm module emitted by that target (in the build dir)
# Optional extra files the target may emit next to the .js (copied into dist/ if present).
WEB_EXTRA_OUTPUTS=(WiiCompiled.data WiiCompiled.wasm.map)
DISC_MANIFEST_NAME=disc-manifest.json
EMSCRIPTEN_RECOMMENDED=6.0.12
CMAKE_MIN=3.25
# Pinned clean PAL RMCP01 hashes; identical to projects/mkwii/recomp.yml and
# Launcher/macos/extract-disc.command.
EXPECTED_DOL_SHA256=80d18895b39c63bd80f457398bfcbb91b7d16ac116a41a88967e954080155b05
EXPECTED_REL_SHA256=16d9d146112541fefea701ecb5bc1a496f9d50e4a752fbb5b6778e7c6399f67d
NODTOOL_VERSION=v2.0.0-alpha.10 # same release the native setup downloads (Launcher/WiiCompiled.Setup.Common)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
workspace=$(cd "$script_dir/.." && pwd)

step_no=0
step() { step_no=$((step_no + 1)); printf '\n==> [%d] %s\n' "$step_no" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'build.sh: warning: %s\n' "$*" >&2; }
fail() { printf 'build.sh: error: %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'USAGE'
Usage: web/build.sh DISC_IMAGE [options]

  DISC_IMAGE            Your own PAL Mario Kart Wii (RMCP01) disc image:
                        ISO, GCM, GCZ, CISO, WBFS, WIA or RVZ.

Options:
  --out DIR             Output site directory (default: web/dist)
  --build-dir DIR       CMake/Ninja + disc extraction work directory (default: web/build)
  --jobs N              Pin translator threads, translated-shard compile pool and Ninja
                        parallelism to N (default: derived from CPU count and RAM)
  --skip-translate      Reuse the existing generated/ translation (skips translate-recursive and
                        emit-base-manifest; generate-data-init and emit-build-shards still run)
  --retro-rewind DIR    TODO: Retro Rewind web build (not implemented yet)
  -h, --help            Show this help

Environment:
  EMSDK                     emsdk checkout; its emsdk_env.sh is sourced if emcc is not on PATH
  NODTOOL                   Path to a nodtool binary (otherwise PATH, then Launcher/artifacts/nodtool)
  MKW_DISC_EXTRACT_CMD      Override the extraction command. Whitespace-separated words, with
                            {IMAGE} and {OUT} replaced, e.g.
                              MKW_DISC_EXTRACT_CMD='/opt/nodtool extract {IMAGE} {OUT} -q'
                              MKW_DISC_EXTRACT_CMD='DolphinTool extract -i {IMAGE} -o {OUT} -p DATA'
                            (paths containing spaces are fine: replacement happens after splitting)
  PYTHON                    Python 3 interpreter (default: python3)
USAGE
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
disc_image=""
out_dir="$workspace/web/dist"
build_dir="$workspace/web/build"
jobs_override=0
skip_translate=0
retro_rewind_dir=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --out) [[ $# -ge 2 ]] || fail "--out needs a value"; out_dir=$2; shift 2 ;;
        --build-dir) [[ $# -ge 2 ]] || fail "--build-dir needs a value"; build_dir=$2; shift 2 ;;
        --jobs) [[ $# -ge 2 ]] || fail "--jobs needs a value"; jobs_override=$2; shift 2 ;;
        --skip-translate) skip_translate=1; shift ;;
        --retro-rewind) [[ $# -ge 2 ]] || fail "--retro-rewind needs a value"; retro_rewind_dir=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        -*) usage >&2; fail "unknown option: $1" ;;
        *)
            [[ -z "$disc_image" ]] || fail "more than one disc image given ('$disc_image' and '$1')"
            disc_image=$1; shift ;;
    esac
done

[[ -n "$disc_image" ]] || { usage >&2; fail "a disc image path is required"; }
[[ -z "$retro_rewind_dir" ]] || fail "--retro-rewind is not implemented for the web build yet (TODO)"
[[ -f "$disc_image" ]] || fail "disc image does not exist: $disc_image"
case "$jobs_override" in ''|*[!0-9]*) fail "--jobs must be a positive integer" ;; esac

abs_dir() { mkdir -p "$1" && (cd "$1" && pwd); }
disc_image=$(cd "$(dirname "$disc_image")" && pwd)/$(basename "$disc_image")
out_dir=$(abs_dir "$out_dir")
build_dir=$(abs_dir "$build_dir")

# ---------------------------------------------------------------------------
# Portable helpers (bash 3.2 / macOS safe)
# ---------------------------------------------------------------------------
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        fail "neither sha256sum nor shasum is available"
    fi
}

sha256_stdin() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'; else shasum -a 256 | awk '{print $1}'; fi
}

file_stat_id() { # size + mtime, GNU or BSD stat
    stat -c '%s-%Y' "$1" 2>/dev/null || stat -f '%z-%m' "$1"
}

# version_ge A B -> success if dotted version A >= B
version_ge() {
    local IFS=. i x y
    local -a a b
    read -r -a a <<<"$1"
    read -r -a b <<<"$2"
    for i in 0 1 2; do
        x=${a[$i]:-0}; y=${b[$i]:-0}
        x=${x//[!0-9]/}; y=${y//[!0-9]/}
        if ((10#${x:-0} > 10#${y:-0})); then return 0; fi
        if ((10#${x:-0} < 10#${y:-0})); then return 1; fi
    done
    return 0
}

first_version() { grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1; }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
step "Checking prerequisites"

# Emscripten ---------------------------------------------------------------
if ! command -v emcc >/dev/null 2>&1; then
    if [[ -n "${EMSDK:-}" && -f "$EMSDK/emsdk_env.sh" ]]; then
        info "emcc not on PATH; sourcing $EMSDK/emsdk_env.sh"
        # shellcheck disable=SC1091
        EMSDK_QUIET=1 source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1 || true
    fi
fi
command -v emcc >/dev/null 2>&1 || fail "Emscripten (emcc) was not found. Install emsdk (https://emscripten.org/docs/getting_started/downloads.html):
    git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install $EMSCRIPTEN_RECOMMENDED && ./emsdk activate $EMSCRIPTEN_RECOMMENDED
  then 'source emsdk_env.sh' in this shell, or set EMSDK to the checkout."
command -v emcmake >/dev/null 2>&1 || fail "emcmake not found next to emcc; your Emscripten install looks incomplete"
emcc_version=$(emcc --version 2>/dev/null | head -n1 | first_version || true)
if [[ -z "$emcc_version" ]]; then
    warn "could not determine the Emscripten version; $EMSCRIPTEN_RECOMMENDED is recommended"
elif [[ "$emcc_version" != "$EMSCRIPTEN_RECOMMENDED" ]]; then
    warn "Emscripten $emcc_version found; $EMSCRIPTEN_RECOMMENDED is the tested version (JSPI flags differ between releases)"
else
    info "Emscripten $emcc_version"
fi

# .NET 8 SDK ----------------------------------------------------------------
command -v dotnet >/dev/null 2>&1 || fail ".NET SDK not found. Install the .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0"
if ! dotnet --list-sdks 2>/dev/null | grep -Eq '^8\.'; then
    fail ".NET 8 SDK not found (installed SDKs: $(dotnet --list-sdks 2>/dev/null | awk '{print $1}' | tr '\n' ' ')). The translator targets net8.0; install https://dotnet.microsoft.com/download/dotnet/8.0"
fi
info ".NET SDK $(dotnet --list-sdks | grep -E '^8\.' | tail -n1 | awk '{print $1}')"

# CMake >= 3.25, Ninja ------------------------------------------------------
command -v cmake >/dev/null 2>&1 || fail "CMake not found (need >= $CMAKE_MIN): https://cmake.org/download/"
cmake_version=$(cmake --version | head -n1 | first_version || true)
version_ge "${cmake_version:-0}" "$CMAKE_MIN" || fail "CMake $cmake_version is too old; need >= $CMAKE_MIN"
info "CMake $cmake_version"
command -v ninja >/dev/null 2>&1 || fail "Ninja not found (apt install ninja-build / brew install ninja)"
info "Ninja $(ninja --version)"

# Python 3 ------------------------------------------------------------------
python_bin=${PYTHON:-python3}
command -v "$python_bin" >/dev/null 2>&1 || fail "Python 3 not found ('$python_bin'); install it or set PYTHON"
"$python_bin" -c 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)' || fail "'$python_bin' is not Python 3"
info "Python $("$python_bin" -c 'import platform; print(platform.python_version())')"

# Disc extractor ------------------------------------------------------------
# Result: extract_cmd is an array of words with {IMAGE}/{OUT} placeholders.
extract_cmd=()
if [[ -n "${MKW_DISC_EXTRACT_CMD:-}" ]]; then
    read -r -a extract_cmd <<<"$MKW_DISC_EXTRACT_CMD"
    info "disc extractor: MKW_DISC_EXTRACT_CMD ($MKW_DISC_EXTRACT_CMD)"
else
    nodtool_bin=""
    if [[ -n "${NODTOOL:-}" ]]; then
        [[ -x "$NODTOOL" ]] || fail "NODTOOL is set but not executable: $NODTOOL"
        nodtool_bin=$NODTOOL
    elif command -v nodtool >/dev/null 2>&1; then
        nodtool_bin=$(command -v nodtool)
    elif [[ -x "$workspace/Launcher/artifacts/nodtool" ]]; then
        nodtool_bin=$workspace/Launcher/artifacts/nodtool # cached by the native setup
    fi
    if [[ -n "$nodtool_bin" ]]; then
        # Same invocation the native setup uses (Launcher/WiiCompiled.Setup.Linux/DiscTool.cs).
        extract_cmd=("$nodtool_bin" extract '{IMAGE}' '{OUT}' -q)
        info "disc extractor: nodtool ($nodtool_bin)"
    else
        dolphin_bin=""
        for candidate in DolphinTool dolphin-tool; do
            if command -v "$candidate" >/dev/null 2>&1; then dolphin_bin=$(command -v "$candidate"); break; fi
        done
        if [[ -n "$dolphin_bin" ]]; then
            extract_cmd=("$dolphin_bin" extract -i '{IMAGE}' -o '{OUT}' -p DATA)
            info "disc extractor: DolphinTool ($dolphin_bin)"
        else
            fail "no disc extractor found. Install one of:
    nodtool     https://github.com/encounter/nod/releases/tag/$NODTOOL_VERSION  (put it on PATH or set NODTOOL=/path/to/nodtool)
    DolphinTool (ships with Dolphin; 'DolphinTool extract -i IMAGE -o DIR')
  or set MKW_DISC_EXTRACT_CMD='<command> {IMAGE} {OUT}' for another tool."
        fi
    fi
fi

# Repo files this script relies on -------------------------------------------
project=$workspace/projects/mkwii/recomp.yml
[[ -f "$project" ]] || fail "translation project not found: $project"
site_src=$workspace/web/site
[[ -f "$site_src/index.html" ]] || fail "frontend not found: $site_src/index.html"
manifest_tool=$workspace/web/tools/make_disc_manifest.py
[[ -f "$manifest_tool" ]] || fail "disc manifest generator is missing: $manifest_tool (expected CLI: make_disc_manifest.py <disc_root> <out.json>)"

# ---------------------------------------------------------------------------
# Parallelism (same three knobs as Launcher/local-build.sh)
# ---------------------------------------------------------------------------
if command -v nproc >/dev/null 2>&1; then cpu_count=$(nproc); else cpu_count=$(sysctl -n hw.ncpu 2>/dev/null || echo 4); fi
if [[ -r /proc/meminfo ]]; then
    mem_gib=$(( $(awk '/^MemTotal:/{print $2}' /proc/meminfo) / 1024 / 1024 ))
else
    mem_gib=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 8589934592) / 1024 / 1024 / 1024 ))
fi
if ((mem_gib < 1)); then mem_gib=1; fi
if ((jobs_override > 0)); then
    translator_threads=$jobs_override; translated_jobs=$jobs_override; global_jobs=$jobs_override
else
    translator_threads=$((cpu_count < 16 ? cpu_count : 16)); if ((translator_threads < 1)); then translator_threads=1; fi
    mem_based_cap=$((mem_gib / 2)); if ((mem_based_cap < 1)); then mem_based_cap=1; fi
    translated_jobs=$((cpu_count < mem_based_cap ? cpu_count : mem_based_cap)); if ((translated_jobs < 1)); then translated_jobs=1; fi
    global_jobs=$((translated_jobs > cpu_count ? translated_jobs : cpu_count))
fi
info "parallelism: translator=$translator_threads translated-compile-pool=$translated_jobs ninja=$global_jobs"

# ---------------------------------------------------------------------------
# (a) Extract the DATA partition
# ---------------------------------------------------------------------------
work_disc=$build_dir/disc            # normalized DATA root: sys/ and files/
stamp=$build_dir/disc.stamp
want_stamp="$disc_image|$(file_stat_id "$disc_image")"

disc_is_valid() {
    [[ -f "$work_disc/sys/main.dol" && -f "$work_disc/files/rel/StaticR.rel" ]]
}

step "Extracting the disc image"
if disc_is_valid && [[ -f "$stamp" && "$(cat "$stamp")" == "$want_stamp" ]]; then
    info "reusing previous extraction in $work_disc (same image, size and mtime)"
else
    tmp_extract=$build_dir/disc.extract.tmp
    rm -rf "$tmp_extract" "$work_disc" "$stamp"
    mkdir -p "$tmp_extract"
    cmd=()
    for word in "${extract_cmd[@]}"; do
        word=${word//\{IMAGE\}/$disc_image}
        word=${word//\{OUT\}/$tmp_extract}
        cmd+=("$word")
    done
    info "running: ${cmd[*]}"
    "${cmd[@]}" || fail "disc extraction failed. Check the image is a valid RMCP01 disc and supported by your extractor (set MKW_DISC_EXTRACT_CMD to use a different command)."

    # Different tools nest the DATA partition differently (out/, out/DATA/, ...): locate sys/main.dol.
    found_dol=$(find "$tmp_extract" -maxdepth 4 -type f -path '*/sys/main.dol' -print | head -n1 || true)
    [[ -n "$found_dol" ]] || fail "extraction did not produce sys/main.dol under $tmp_extract (is this a Wii disc with a DATA partition?)"
    data_root=$(dirname "$(dirname "$found_dol")")
    [[ -f "$data_root/files/rel/StaticR.rel" ]] || fail "extraction did not produce files/rel/StaticR.rel under $data_root"
    mv "$data_root" "$work_disc"
    rm -rf "$tmp_extract"
fi

# ---------------------------------------------------------------------------
# (b) Verify the clean PAL hashes
# ---------------------------------------------------------------------------
step "Verifying the disc is a clean PAL RMCP01 image"
dol_sha=$(sha256_of "$work_disc/sys/main.dol")
rel_sha=$(sha256_of "$work_disc/files/rel/StaticR.rel")
if [[ "$dol_sha" != "$EXPECTED_DOL_SHA256" ]]; then
    rm -f "$stamp"
    fail "main.dol sha256 mismatch: expected $EXPECTED_DOL_SHA256, got $dol_sha. Only an unmodified PAL (RMCP01) Mario Kart Wii disc is supported."
fi
if [[ "$rel_sha" != "$EXPECTED_REL_SHA256" ]]; then
    rm -f "$stamp"
    fail "StaticR.rel sha256 mismatch: expected $EXPECTED_REL_SHA256, got $rel_sha. Use a clean PAL (RMCP01) image."
fi
printf '%s' "$want_stamp" > "$stamp"
info "main.dol and StaticR.rel match"

# ---------------------------------------------------------------------------
# (c) Translate (same commands, order and arguments as Launcher/local-build.sh, base profile)
# ---------------------------------------------------------------------------
assets=$workspace/Assets
generated=$workspace/generated
functions=$generated/functions
base_metadata=$generated/base_translation_output.json
base_manifest_dir=$workspace/build/base
base_manifest=$base_manifest_dir/mkwii_base_manifest.json
shards=$generated/build_shards
translation_provenance=$generated/translation-provenance.json

step "Staging main.dol and StaticR.rel into Assets/ (git-ignored)"
mkdir -p "$assets"
cp -f "$work_disc/sys/main.dol" "$assets/main.dol"
cp -f "$work_disc/files/rel/StaticR.rel" "$assets/StaticR.rel"

step "Building the translator"
translator_dll=$workspace/translator/src/Translator.Cli/bin/Release/net8.0/Translator.Cli.dll
dotnet build "$workspace/translator/src/Translator.Cli/Translator.Cli.csproj" -c Release
[[ -f "$translator_dll" ]] || fail "Translator.Cli.dll was not produced: $translator_dll"
translator() { dotnet "$translator_dll" "$@"; }

entry_point=$(awk '
    /^translation:/ { in_translation = 1 }
    in_translation && /^[[:space:]]*-[[:space:]]*0[xX][0-9a-fA-F]+[[:space:]]*$/ {
        gsub(/^[[:space:]]*-[[:space:]]*/, ""); gsub(/[[:space:]]*$/, ""); print; exit
    }
' "$project")
[[ -n "$entry_point" ]] || fail "could not find a translation entry point in $project"

translation_fingerprint=$(cat "$assets/main.dol" "$assets/StaticR.rel" "$project" | sha256_stdin)
reuse_base=0
if ((skip_translate)); then
    [[ -f "$base_metadata" && -f "$base_manifest" && -d "$functions" ]] \
        || fail "--skip-translate needs an existing translation ($base_metadata, $base_manifest, $functions); run once without it"
    reuse_base=1
elif [[ -f "$translation_provenance" ]]; then
    recorded=$(grep -o '"TranslationFingerprint" *: *"[^"]*"' "$translation_provenance" 2>/dev/null | sed 's/.*"\([0-9a-f]*\)"$/\1/' || true)
    if [[ "$recorded" == "$translation_fingerprint" && -f "$base_metadata" && -f "$base_manifest" ]]; then
        reuse_base=1
    fi
fi

if ((reuse_base)); then
    step "Reusing the completed base translation"
else
    rm -f "$translation_provenance"
    mkdir -p "$generated" "$base_manifest_dir"

    step "Translating the base game (about a minute, 8+ GB of RAM recommended)"
    translator translate-recursive "$entry_point" --project "$project" \
        --outdir "$functions" --output-metadata "$base_metadata" \
        --production-source-bundle "$generated/base_translation_sources.bin" \
        --no-function-files --prune-stale --threads "$translator_threads"

    step "Creating the base translation manifest"
    translator emit-base-manifest --project "$project" --out "$base_manifest_dir" \
        --functions-dir "$functions" --translation-output-metadata "$base_metadata" --region P

    printf '{"SchemaVersion":1,"TranslationFingerprint":"%s"}' "$translation_fingerprint" > "$translation_provenance"
fi

step "Generating game data initialization"
translator generate-data-init --project "$project"

step "Emitting build shards"
translator emit-build-shards --project "$project" --base-metadata "$base_metadata" \
    --base-functions-dir "$functions" --native-source-dir "$workspace/runtime/src" --out "$shards"

# ---------------------------------------------------------------------------
# (d) Emscripten configure + build
# ---------------------------------------------------------------------------
cmake_build=$build_dir/wasm
if [[ -f "$cmake_build/CMakeCache.txt" ]]; then
    cache_home=$(grep '^CMAKE_HOME_DIRECTORY:INTERNAL=' "$cmake_build/CMakeCache.txt" | cut -d= -f2- || true)
    cache_tc=$(grep '^CMAKE_TOOLCHAIN_FILE:' "$cmake_build/CMakeCache.txt" | cut -d= -f2- || true)
    if [[ "$cache_home" != "$workspace/runtime" || "$cache_tc" != *Emscripten* ]]; then
        info "CMake cache in $cmake_build belongs to another source tree or toolchain; rebuilding from scratch"
        rm -rf "$cmake_build"
    fi
fi

step "Configuring the WebAssembly build (emcmake)"
emcmake cmake -S "$workspace/runtime" -B "$cmake_build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DMKW_PLATFORM_WEB_DIST="$out_dir" \
    -DMKW_TRANSLATED_COMPILE_JOBS="$translated_jobs"

step "Compiling $WEB_TARGET to WebAssembly (this is the long step)"
cmake --build "$cmake_build" --target "$WEB_TARGET" --parallel "$global_jobs"

# ---------------------------------------------------------------------------
# (e) Assemble the static site
# ---------------------------------------------------------------------------
step "Assembling $out_dir"
mkdir -p "$out_dir"
cp -R "$site_src"/. "$out_dir"/

# The CMake target may emit into the build dir or (via MKW_PLATFORM_WEB_DIST) straight into dist.
for name in "$WEB_JS_NAME" "$WEB_WASM_NAME"; do
    src=""
    for dir in "$cmake_build" "$cmake_build/web" "$out_dir"; do
        if [[ -f "$dir/$name" ]]; then src=$dir/$name; break; fi
    done
    [[ -n "$src" ]] || fail "$WEB_TARGET did not produce $name (looked in $cmake_build, $cmake_build/web, $out_dir). Adjust WEB_JS_NAME/WEB_WASM_NAME at the top of web/build.sh."
    if [[ "$src" != "$out_dir/$name" ]]; then cp -f "$src" "$out_dir/$name"; fi
    info "$name ($(du -h "$out_dir/$name" | awk '{print $1}'))"
done
for name in "${WEB_EXTRA_OUTPUTS[@]}"; do
    if [[ -f "$cmake_build/$name" ]]; then cp -f "$cmake_build/$name" "$out_dir/$name"; info "$name"; fi
done

info "copying the disc tree (sys/ and files/) to $out_dir/disc"
rm -rf "$out_dir/disc"
mkdir -p "$out_dir/disc"
cp -R "$work_disc/sys" "$out_dir/disc/sys"
cp -R "$work_disc/files" "$out_dir/disc/files"

info "generating $DISC_MANIFEST_NAME"
"$python_bin" "$manifest_tool" "$out_dir/disc" "$out_dir/$DISC_MANIFEST_NAME" \
    || fail "make_disc_manifest.py failed"
[[ -s "$out_dir/$DISC_MANIFEST_NAME" ]] || fail "$DISC_MANIFEST_NAME was not written"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
dist_size=$(du -sh "$out_dir" | awk '{print $1}')
disc_size=$(du -sh "$out_dir/disc" | awk '{print $1}')
cat <<EOF

==> Done
    Site:        $out_dir
    Total size:  $dist_size  (disc tree $disc_size, streamed lazily over HTTP Range)
    Serve:       $python_bin $workspace/web/serve.py --dir "$out_dir"      # http://127.0.0.1:8080/
    Host:        any static server with HTTP Range support (nginx, Caddy, ...), serving .wasm as application/wasm.
    Players need Chrome/Edge 137+ (WebGPU + JSPI).
EOF
