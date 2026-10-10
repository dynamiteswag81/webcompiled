#!/usr/bin/env bash
# WiiCompiled for the Web - operator pipeline (Linux / macOS).
#
#   web/build.sh DISC_IMAGE_OR_EXTRACTED_DIR [--retro-rewind DIR] [--out DIR] [--build-dir DIR]
#                [--jobs N] [--skip-translate]
#
# Takes the operator's own PAL (RMCP01) Mario Kart Wii disc image (or an already extracted DATA
# partition tree), extracts it, runs the same translator pipeline as Launcher/local-build.sh,
# compiles the runtime + translated code to WebAssembly with Emscripten, and writes a
# self-contained static site (default web/dist/). With --retro-rewind DIR it also translates and
# builds the Retro Rewind product (web/host.sh is the drop-in wrapper that does all of this).
# Any static web server with HTTP Range support can host that directory; `web/serve.py` is a
# small one for local testing. The repository itself never contains game data.
#
# Windows: use web/build.ps1 (same options).
set -euo pipefail

# ---------------------------------------------------------------------------
# Settings you may want to adjust (names of the CMake target and its outputs).
# ---------------------------------------------------------------------------
# CMake targets that link web products: <Target>.js (Emscripten glue) + <Target>.wasm, plus the
# optional extras <Target>.data / <Target>.wasm.map. RetroRewind is added with --retro-rewind.
BASE_TARGET=WiiCompiled
RETRO_TARGET=RetroRewind
WEB_EXTRA_SUFFIXES=(.data .wasm.map)
DISC_MANIFEST_NAME=disc-manifest.json
MODS_DIR_NAME=mods
RETRO_MOD_DIR_NAME=RetroRewind6   # dist/mods/RetroRewind6 + dist/mods/RetroRewind6-manifest.json
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
Usage: web/build.sh DISC_IMAGE_OR_DIR [options]

  DISC_IMAGE_OR_DIR     Your own PAL Mario Kart Wii (RMCP01) disc image (ISO, GCM, GCZ, CISO,
                        WBFS, WIA or RVZ) OR an already extracted DATA partition tree (a
                        directory holding sys/main.dol and files/; one extra level of nesting,
                        e.g. DIR/DATA/sys/main.dol, is accepted). A tree skips the extraction;
                        the clean-PAL hash check still runs.

Options:
  --out DIR             Output site directory (default: web/dist)
  --build-dir DIR       CMake/Ninja + disc extraction work directory (default: web/build)
  --jobs N              Pin translator threads, translated-shard compile pool and Ninja
                        parallelism to N (default: derived from CPU count and RAM)
  --skip-translate      Reuse the existing generated/ translation (skips translate-recursive and
                        emit-base-manifest; generate-data-init and emit-build-shards still run)
  --retro-rewind DIR    Also build Retro Rewind: DIR is the RetroRewind6 folder (it contains
                        Binaries/Code.pul) or a folder containing RetroRewind6/. Adds the
                        RetroRewind product, dist/mods/RetroRewind6 (+ manifest) and
                        dist/products.json lists both products. Networking is compiled out of
                        the web build, so no Retro-WFC payload is used.
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
[[ -e "$disc_image" ]] || fail "disc image or extracted tree does not exist: $disc_image"
disc_is_tree=0
[[ -d "$disc_image" ]] && disc_is_tree=1
[[ -z "$retro_rewind_dir" || -d "$retro_rewind_dir" ]] || fail "--retro-rewind: not a directory: $retro_rewind_dir"
case "$jobs_override" in ''|*[!0-9]*) fail "--jobs must be a positive integer" ;; esac

abs_dir() { mkdir -p "$1" && (cd "$1" && pwd); }
if ((disc_is_tree)); then disc_image=$(cd "$disc_image" && pwd); else disc_image=$(cd "$(dirname "$disc_image")" && pwd)/$(basename "$disc_image"); fi
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
# Result: extract_cmd is an array of words with {IMAGE}/{OUT} placeholders. Not needed when the
# input is already an extracted tree.
extract_cmd=()
if ((disc_is_tree)); then
    info "input is an extracted tree; no disc extractor needed"
elif [[ -n "${MKW_DISC_EXTRACT_CMD:-}" ]]; then
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
precompress_tool=$workspace/web/tools/precompress_dist.py
[[ -f "$manifest_tool" ]] || fail "disc manifest generator is missing: $manifest_tool (expected CLI: make_disc_manifest.py <disc_root> <out.json>)"

# Retro Rewind input -----------------------------------------------------------
# retro_root = the RetroRewind6 folder (has Binaries/Code.pul), found in DIR, DIR/RetroRewind6 or
# one of a few levels below DIR (e.g. DIR/RetroRewind/RetroRewind6).
retro_root=""
if [[ -n "$retro_rewind_dir" ]]; then
    retro_rewind_dir=$(cd "$retro_rewind_dir" && pwd)
    if [[ -f "$retro_rewind_dir/Binaries/Code.pul" ]]; then
        retro_root=$retro_rewind_dir
    elif [[ -f "$retro_rewind_dir/RetroRewind6/Binaries/Code.pul" ]]; then
        retro_root=$retro_rewind_dir/RetroRewind6
    else
        found_pul=$(find "$retro_rewind_dir" -maxdepth 4 -type f -path '*/Binaries/Code.pul' -print 2>/dev/null | sort || true)
        n_pul=$(printf '%s' "$found_pul" | grep -c . || true)
        [[ "$n_pul" -ge 1 ]] || fail "--retro-rewind: no Binaries/Code.pul found in $retro_rewind_dir. Pass the RetroRewind6 folder (the one that contains Binaries/Code.pul) or its parent."
        [[ "$n_pul" -eq 1 ]] || fail "--retro-rewind: several Code.pul files found under $retro_rewind_dir; pass the RetroRewind6 folder itself:
$found_pul"
        retro_root=$(dirname "$(dirname "$found_pul")")
    fi
    info "Retro Rewind: $retro_root"
fi
build_retro=0
[[ -z "$retro_root" ]] || build_retro=1

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
# (a) Extract the DATA partition (or use the extracted tree as given)
# ---------------------------------------------------------------------------
disc_is_valid() { # $1 = candidate DATA root
    [[ -f "$1/sys/main.dol" && -f "$1/files/rel/StaticR.rel" ]]
}

if ((disc_is_tree)); then
    stamp=""
    step "Locating the extracted disc tree"
    work_disc=""
    if [[ -f "$disc_image/sys/main.dol" ]]; then
        work_disc=$disc_image
    else
        found_dol=$(find "$disc_image" -maxdepth 3 -type f -path '*/sys/main.dol' -print 2>/dev/null | head -n1 || true)
        [[ -z "$found_dol" ]] || work_disc=$(dirname "$(dirname "$found_dol")")
    fi
    [[ -n "$work_disc" ]] || fail "no sys/main.dol found in $disc_image (or one folder below it). An extracted tree must contain sys/main.dol and files/."
    disc_is_valid "$work_disc" || fail "$work_disc has sys/main.dol but no files/rel/StaticR.rel; the tree looks incomplete (is it the DATA partition?)"
    info "using $work_disc (no extraction)"
else
    work_disc=$build_dir/disc            # normalized DATA root: sys/ and files/
    stamp=$build_dir/disc.stamp
    want_stamp="$disc_image|$(file_stat_id "$disc_image")"

    step "Extracting the disc image"
    if disc_is_valid "$work_disc" && [[ -f "$stamp" && "$(cat "$stamp")" == "$want_stamp" ]]; then
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
fi

# ---------------------------------------------------------------------------
# (b) Verify the clean PAL hashes
# ---------------------------------------------------------------------------
step "Verifying the disc is a clean PAL RMCP01 image"
dol_sha=$(sha256_of "$work_disc/sys/main.dol")
rel_sha=$(sha256_of "$work_disc/files/rel/StaticR.rel")
if [[ "$dol_sha" != "$EXPECTED_DOL_SHA256" ]]; then
    [[ -z "$stamp" ]] || rm -f "$stamp"
    fail "main.dol sha256 mismatch: expected $EXPECTED_DOL_SHA256, got $dol_sha. Only an unmodified PAL (RMCP01) Mario Kart Wii disc is supported."
fi
if [[ "$rel_sha" != "$EXPECTED_REL_SHA256" ]]; then
    [[ -z "$stamp" ]] || rm -f "$stamp"
    fail "StaticR.rel sha256 mismatch: expected $EXPECTED_REL_SHA256, got $rel_sha. Use a clean PAL (RMCP01) image."
fi
[[ -z "$stamp" ]] || printf '%s' "$want_stamp" > "$stamp"
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

if ((build_retro)); then
    # Same as Launcher/local-build.sh: the translator finds the mod through the project file's
    # workspace-relative profile paths, and both the base and the mod leg block leaf inlining at
    # every address the profile patches, so the selected Code.pul must sit at the profile's
    # mod_root before either leg runs.
    source_pul=$retro_root/Binaries/Code.pul
    staged_binaries=$workspace/PulsarPacks/completed/RetroRewind/RetroRewind6/Binaries
    mkdir -p "$staged_binaries"
    staged_pul=$staged_binaries/Code.pul
    if [[ "$(cd "$(dirname "$source_pul")" && pwd)/$(basename "$source_pul")" != "$(cd "$staged_binaries" && pwd)/$(basename "$staged_pul")" ]]; then
        step "Staging Retro Rewind's Code.pul into PulsarPacks/ (ignored by version control)"
        cp -f "$source_pul" "$staged_pul"
    fi
fi

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

if ((reuse_base)) && ((build_retro)); then
    # A base tree that never saw this Code.pul would silently bake vanilla code into the modded
    # product; check-base-mod-awareness fails closed (anything but exit 0 forces a retranslation).
    pul_sha=$(sha256_of "$retro_root/Binaries/Code.pul")
    if ! grep -q "\"codePulSha256\":\"$pul_sha\"" "$base_metadata"; then
        if ! translator check-base-mod-awareness --project "$project" --profile retro-rewind \
            --translation-output-metadata "$base_metadata" --code-pul "$retro_root/Binaries/Code.pul"; then
            info "the base translation is stale for this Code.pul; retranslating the base game"
            reuse_base=0
        fi
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

retro_out=$workspace/build/mods/retro_rewind_full_cpp
if ((build_retro)); then
    # Mirrors Launcher/local-build.sh (--profile both). The browser build has networking compiled
    # out, so there is never a Retro-WFC payload: --skip-retro-wfc.
    step "Translating the selected Retro Rewind Code.pul"
    translator translate-mod --project "$project" --profile retro-rewind \
        --base-manifest "$base_manifest" --base-translation-output-metadata "$base_metadata" \
        --code-pul "$retro_root/Binaries/Code.pul" --mod-root "$retro_root" --mod-name "Retro Rewind" \
        --region P --out "$retro_out" --prefer-cached-inputs --emit-cpp \
        --threads "$translator_threads" --skip-retro-wfc
fi

step "Generating game data initialization"
translator generate-data-init --project "$project"

step "Emitting build shards"
shard_args=(emit-build-shards --project "$project" --base-metadata "$base_metadata"
    --base-functions-dir "$functions" --native-source-dir "$workspace/runtime/src" --out "$shards")
if ((build_retro)); then
    shard_args+=(--resolved-profile "$retro_out/resolved_dispatch_profile.json" --retro-cpp-dir "$retro_out/cpp")
fi
translator "${shard_args[@]}"

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

# Prebuilt libraries without game content (aurora, SDL3, abseil, ...; see
# web/tools/make_web_prebuilt.py): when the shipped package is present, only the runtime and
# the game compile here. CMake verifies the package against this checkout and falls back to a
# from-source build by itself if it does not match.
prebuilt_args=()
prebuilt_archive=$workspace/web/prebuilt/web-prebuilt.tar.xz
if [[ -f "$prebuilt_archive" && -f "$prebuilt_archive.sha256" ]]; then
    prebuilt_sha=$(awk '{print $1}' "$prebuilt_archive.sha256")
    prebuilt_dir=$build_dir/web-prebuilt
    if [[ "$(cat "$prebuilt_dir/.archive-sha256" 2>/dev/null)" != "$prebuilt_sha" ]]; then
        [[ "$(sha256_of "$prebuilt_archive")" == "$prebuilt_sha" ]] \
            || fail "web/prebuilt/web-prebuilt.tar.xz does not match its .sha256 file (corrupt download?)"
        rm -rf "$prebuilt_dir"
        mkdir -p "$build_dir"
        tar -xJf "$prebuilt_archive" -C "$build_dir"
        printf '%s' "$prebuilt_sha" > "$prebuilt_dir/.archive-sha256"
    fi
    prebuilt_args=(-DMKW_WEB_PREBUILT_DIR="$prebuilt_dir")
    info "using the prebuilt web libraries (aurora, SDL3, ...): only the runtime and the game compile"
fi

step "Configuring the WebAssembly build (emcmake)"
emcmake cmake -S "$workspace/runtime" -B "$cmake_build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DMKW_PLATFORM_WEB_DIST="$out_dir" \
    -DMKW_TRANSLATED_COMPILE_JOBS="$translated_jobs" \
    ${prebuilt_args[@]+"${prebuilt_args[@]}"}

targets=("$BASE_TARGET")
if ((build_retro)); then targets+=("$RETRO_TARGET"); fi

step "Compiling ${targets[*]} to WebAssembly (this is the long step)"
build_args=(--build "$cmake_build")
for target in "${targets[@]}"; do build_args+=(--target "$target"); done
cmake "${build_args[@]}" --parallel "$global_jobs"

# ---------------------------------------------------------------------------
# (e) Assemble the static site
# ---------------------------------------------------------------------------
step "Assembling $out_dir"
mkdir -p "$out_dir"
cp -R "$site_src"/. "$out_dir"/
rm -f "$out_dir/products.json"

# Each target emits into the build dir or (via MKW_PLATFORM_WEB_DIST) straight into dist.
for target in "${targets[@]}"; do
    for name in "$target.js" "$target.wasm"; do
        src=""
        for dir in "$cmake_build" "$cmake_build/web" "$out_dir"; do
            if [[ -f "$dir/$name" ]]; then src=$dir/$name; break; fi
        done
        [[ -n "$src" ]] || fail "$target did not produce $name (looked in $cmake_build, $cmake_build/web, $out_dir)."
        if [[ "$src" != "$out_dir/$name" ]]; then cp -f "$src" "$out_dir/$name"; fi
        info "$name ($(du -h "$out_dir/$name" | awk '{print $1}'))"
    done
    for suffix in "${WEB_EXTRA_SUFFIXES[@]}"; do
        if [[ -f "$cmake_build/$target$suffix" ]]; then cp -f "$cmake_build/$target$suffix" "$out_dir/$target$suffix"; info "$target$suffix"; fi
    done
done

info "copying the disc tree (sys/ and files/) to $out_dir/disc"
rm -rf "$out_dir/disc"
mkdir -p "$out_dir/disc"
# Hard links when source and dist share a filesystem (the files are never modified); else copy.
for part in sys files; do
    cp -Rl "$work_disc/$part" "$out_dir/disc/$part" 2>/dev/null || { rm -rf "$out_dir/disc/$part"; cp -R "$work_disc/$part" "$out_dir/disc/$part"; }
done

info "generating $DISC_MANIFEST_NAME"
"$python_bin" "$manifest_tool" "$out_dir/disc" "$out_dir/$DISC_MANIFEST_NAME" \
    || fail "make_disc_manifest.py failed"
[[ -s "$out_dir/$DISC_MANIFEST_NAME" ]] || fail "$DISC_MANIFEST_NAME was not written"

# products.json tells the page which products this site holds (more than one shows a choice screen).
products_json='[{"id":"WiiCompiled","title":"Mario Kart Wii","glue":"WiiCompiled.js"}'
if ((build_retro)); then
    mod_dest=$out_dir/$MODS_DIR_NAME/$RETRO_MOD_DIR_NAME
    info "copying the Retro Rewind mod tree to $mod_dest"
    rm -rf "$out_dir/$MODS_DIR_NAME"
    mkdir -p "$out_dir/$MODS_DIR_NAME"
    cp -Rl "$retro_root" "$mod_dest" 2>/dev/null || { rm -rf "$mod_dest"; cp -R "$retro_root" "$mod_dest"; }
    info "generating $MODS_DIR_NAME/$RETRO_MOD_DIR_NAME-manifest.json"
    "$python_bin" "$manifest_tool" --tree "$mod_dest" "$out_dir/$MODS_DIR_NAME/$RETRO_MOD_DIR_NAME-manifest.json" \
        || fail "make_disc_manifest.py failed for the Retro Rewind mod tree"
    products_json+=',{"id":"RetroRewind","title":"Retro Rewind","glue":"RetroRewind.js","modRoot":"'$MODS_DIR_NAME/$RETRO_MOD_DIR_NAME'"}'
else
    # A previous build of this dist dir may have had Retro Rewind; do not leave it half there.
    rm -rf "$out_dir/$MODS_DIR_NAME"
    rm -f "$out_dir/$RETRO_TARGET".js "$out_dir/$RETRO_TARGET".wasm "$out_dir/$RETRO_TARGET".data "$out_dir/$RETRO_TARGET".wasm.map
    rm -f "$out_dir/$RETRO_TARGET".????????.wasm "$out_dir/$RETRO_TARGET".????????.wasm.gz "$out_dir/$RETRO_TARGET".????????.wasm.br
fi
products_json+=']'
printf '%s\n' "$products_json" > "$out_dir/products.json"

# Content-hash the wasm files (cache forever), write .gz/.br next to them and record the names and
# sizes in products.json. See docs/web-hosting.md ("Caching and compression").
step "Hashing and precompressing the wasm files"
"$python_bin" "$precompress_tool" "$out_dir" || fail "precompress_dist.py failed"
info "products.json: $(cat "$out_dir/products.json")"

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
    Products:    $(grep -o '"id":"[A-Za-z]*"' "$out_dir/products.json" | cut -d'"' -f4 | tr '\n' ' ')
    Host:        any static server with HTTP Range support (nginx, Caddy, ...), serving .wasm as application/wasm.
                 Other devices need HTTPS for WebGPU: add --https --lan to serve.py (docs/web-hosting.md).
    Players need Chrome/Edge 137+ (WebGPU + JSPI).
EOF
