#!/usr/bin/env bash
# WiiCompiled for the Web - drop-in host entry point (Linux / macOS).
#
#   1. put your own game files into web/game/   (see web/game/README.md)
#   2. run   web/host.sh
#
# It finds your disc image (or extracted DATA tree) and an optional Retro Rewind folder, builds
# the site once with web/build.sh (translate + compile; slow the first time), remembers what it
# built, and serves web/dist on http://0.0.0.0:8080/. Next runs skip the build until the game
# files or this repository change.
#
# Windows: use web/host.ps1.   Docker: `docker compose up` (see web/docker/).
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
workspace=$(cd "$script_dir/.." && pwd)

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
DISC_EXTENSIONS=(iso gcm gcz ciso wbfs wia rvz)
FINGERPRINT_FILE=.build-fingerprint
EMSCRIPTEN_RECOMMENDED=6.0.12
NODTOOL_VERSION=v2.0.0-alpha.10 # keep in step with web/build.sh

game_dir=${MKW_GAME_DIR:-$workspace/web/game}
out_dir=$workspace/web/dist
port=${PORT:-8080}
bind=0.0.0.0
serve_extra=()      # --https / --cert / --key / --san, passed on to web/serve.py
https=0
mode=all            # all | build-only | serve-only
force_rebuild=0
jobs=${MKW_JOBS:-}

say()  { printf '%s\n' "$*"; }
warn() { printf 'host.sh: warning: %s\n' "$*" >&2; }
fail() { printf 'host.sh: error: %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'USAGE'
Usage: web/host.sh [options]

Builds (once) and serves WiiCompiled in the browser from the game files you drop in web/game/.

  --game DIR      Folder with your game files (default: web/game, or $MKW_GAME_DIR)
  --port N        Port to serve on (default: 8080, or $PORT)
  --bind ADDR     Address to bind (default: 0.0.0.0, all interfaces)
  --lan           Listen on all interfaces (already the default here; same as --bind 0.0.0.0)
  --https         Serve HTTPS with a self-signed certificate (generated once, cached in web/.certs/).
                  Other devices need HTTPS for WebGPU; their browsers show a one-time warning.
  --cert FILE --key FILE
                  Serve HTTPS with your own certificate instead (implies --https)
  --san NAME      Extra host name or IP for the generated certificate (repeatable)
  --build-only    Build (if needed) and exit; do not start the server
  --serve-only    Serve the existing web/dist; never build
  --rebuild       Build again even if nothing changed (compile caches are still reused)
  --jobs N        Limit build parallelism to N (use this on machines with little RAM)
  --out DIR       Site output directory (default: web/dist)
  -h, --help      Show this help

The game folder must contain EITHER one disc image (.iso .gcm .gcz .ciso .wbfs .wia .rvz) OR an
extracted DATA partition (a folder with sys/main.dol and files/), and OPTIONALLY the Retro Rewind
folder (RetroRewind6/, which contains Binaries/Code.pul) to also offer Retro Rewind.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --game)  [[ $# -ge 2 ]] || fail "--game needs a folder"; game_dir=$2; shift 2 ;;
        --port)  [[ $# -ge 2 ]] || fail "--port needs a number"; port=$2; shift 2 ;;
        --bind)  [[ $# -ge 2 ]] || fail "--bind needs an address"; bind=$2; shift 2 ;;
        --lan)   bind=0.0.0.0; shift ;;
        --https) https=1; serve_extra+=(--https); shift ;;
        --cert)  [[ $# -ge 2 ]] || fail "--cert needs a file"; https=1; serve_extra+=(--cert "$2"); shift 2 ;;
        --key)   [[ $# -ge 2 ]] || fail "--key needs a file"; serve_extra+=(--key "$2"); shift 2 ;;
        --san)   [[ $# -ge 2 ]] || fail "--san needs a name or address"; serve_extra+=(--san "$2"); shift 2 ;;
        --out)   [[ $# -ge 2 ]] || fail "--out needs a folder"; out_dir=$2; shift 2 ;;
        --jobs)  [[ $# -ge 2 ]] || fail "--jobs needs a number"; jobs=$2; shift 2 ;;
        --build-only) [[ $mode != serve-only ]] || fail "--build-only and --serve-only cannot be combined"; mode=build-only; shift ;;
        --serve-only) [[ $mode != build-only ]] || fail "--build-only and --serve-only cannot be combined"; mode=serve-only; shift ;;
        --rebuild) force_rebuild=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; fail "unknown option: $1" ;;
    esac
done

case "$port" in ''|*[!0-9]*) fail "--port must be a number (got '$port')" ;; esac
case "$jobs" in ''|*[!0-9]*) [[ -z "$jobs" ]] || fail "--jobs must be a number (got '$jobs')" ;; esac

mkdir -p "$out_dir"
out_dir=$(cd "$out_dir" && pwd)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
sha256_stdin() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'; else shasum -a 256 | awk '{print $1}'; fi
}
file_stat_id() { stat -c '%s-%Y' "$1" 2>/dev/null || stat -f '%z-%m' "$1"; }
abs_path() { if [[ -d "$1" ]]; then (cd "$1" && pwd); else printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"; fi; }

# ---------------------------------------------------------------------------
# Serve-only
# ---------------------------------------------------------------------------
serve() {
    [[ -f "$out_dir/index.html" ]] || fail "nothing to serve in $out_dir yet. Run web/host.sh without --serve-only to build first."
    command -v python3 >/dev/null 2>&1 || fail "python3 is needed to serve the site (https://www.python.org/downloads/)"
    local shown=$bind
    case "$bind" in 0.0.0.0|::) shown=localhost ;; esac
    say ""
    if (( https )); then
        say "Serving over HTTPS (the addresses to open are listed below)."
    else
        say "Serving the game at  http://$shown:$port/"
        say "Players need Chrome or Edge 137+ (WebGPU). Other computers need HTTPS to use WebGPU:"
        say "run again with --https (self-signed certificate, see docs/web-hosting.md) or put this behind"
        say "a TLS proxy (Caddy, nginx, a tunnel); http://localhost works as is."
    fi
    say ""
    exec python3 "$workspace/web/serve.py" --dir "$out_dir" --bind "$bind" --port "$port" ${serve_extra[@]+"${serve_extra[@]}"}
}

if [[ "$mode" == serve-only ]]; then
    serve
fi

# ---------------------------------------------------------------------------
# Find the game files
# ---------------------------------------------------------------------------
no_game_help() {
    cat >&2 <<EOF

No game files found in:
    $game_dir

  1. Put ONE of these into that folder:
       - your own PAL (RMCP01) Mario Kart Wii disc image:
         .iso .gcm .gcz .ciso .wbfs .wia or .rvz
       - or an already extracted DATA partition: a folder that contains
         sys/main.dol and files/
  2. Optional, for Retro Rewind: also drop the RetroRewind6 folder there
     (the one that contains Binaries/Code.pul).
  3. Run web/host.sh again (Docker: docker compose up).

The files stay on your machine; nothing is ever uploaded or committed.
EOF
    exit 2
}

[[ -d "$game_dir" ]] || { mkdir -p "$game_dir" 2>/dev/null || true; }
[[ -d "$game_dir" ]] || fail "game folder does not exist and could not be created: $game_dir"
game_dir=$(cd "$game_dir" && pwd)

# Disc images (up to two levels deep, so a games/ subfolder works).
find_args=()
for ext in "${DISC_EXTENSIONS[@]}"; do
    [[ ${#find_args[@]} -eq 0 ]] || find_args+=(-o)
    find_args+=(-iname "*.$ext")
done
images=()
while IFS= read -r line; do [[ -n "$line" ]] && images+=("$line"); done < <(
    find "$game_dir" -maxdepth 2 -type f \( "${find_args[@]}" \) ! -name '._*' -print 2>/dev/null | sort)

# Extracted DATA trees: game/sys/main.dol, or one folder deeper (game/DATA/sys/main.dol).
trees=()
if [[ -f "$game_dir/sys/main.dol" ]]; then
    trees+=("$game_dir")
else
    while IFS= read -r line; do [[ -n "$line" ]] && trees+=("$(dirname "$(dirname "$line")")"); done < <(
        find "$game_dir" -maxdepth 3 -type f -path '*/sys/main.dol' -print 2>/dev/null | sort)
fi

# Retro Rewind: RetroRewind6/Binaries/Code.pul, directly or inside a parent folder.
pul_files=()
while IFS= read -r line; do [[ -n "$line" ]] && pul_files+=("$line"); done < <(
    find "$game_dir" -maxdepth 4 -type f -path '*/Binaries/Code.pul' -print 2>/dev/null | sort)

if [[ ${#images[@]} -gt 0 && ${#trees[@]} -gt 0 ]]; then
    {
        say ""
        say "Found both a disc image and an extracted game folder in $game_dir:"
        say "    ${images[0]}"
        say "    ${trees[0]}"
        say "Keep only one of them (move the other out of the folder) and run web/host.sh again."
    } >&2
    exit 2
fi
if [[ ${#images[@]} -gt 1 ]]; then
    {
        say ""
        say "Found ${#images[@]} disc images in $game_dir, but exactly one is wanted:"
        printf '    %s\n' "${images[@]}"
        say "Move the extra ones out of the folder and run web/host.sh again."
    } >&2
    exit 2
fi
if [[ ${#trees[@]} -gt 1 ]]; then
    {
        say ""
        say "Found ${#trees[@]} extracted game folders (with sys/main.dol) in $game_dir:"
        printf '    %s\n' "${trees[@]}"
        say "Keep only one and run web/host.sh again."
    } >&2
    exit 2
fi
if [[ ${#pul_files[@]} -gt 1 ]]; then
    {
        say ""
        say "Found ${#pul_files[@]} Retro Rewind Code.pul files in $game_dir:"
        printf '    %s\n' "${pul_files[@]}"
        say "Keep only one Retro Rewind folder and run web/host.sh again."
    } >&2
    exit 2
fi

if [[ ${#images[@]} -eq 1 ]]; then
    input=${images[0]}; input_kind=image
elif [[ ${#trees[@]} -eq 1 ]]; then
    input=${trees[0]}; input_kind=tree
else
    no_game_help
fi

retro_root=""
if [[ ${#pul_files[@]} -eq 1 ]]; then
    retro_root=$(dirname "$(dirname "${pul_files[0]}")")
fi

say "Game files:"
say "    base game:     $input ($input_kind)"
if [[ -n "$retro_root" ]]; then say "    Retro Rewind:  $retro_root"; else say "    Retro Rewind:  not found (optional)"; fi

# ---------------------------------------------------------------------------
# Fingerprint = game inputs + repository version
# ---------------------------------------------------------------------------
repo_version() {
    if [[ -n "${MKW_REPO_COMMIT:-}" ]]; then printf '%s' "$MKW_REPO_COMMIT"; return; fi
    local head
    if head=$(git -C "$workspace" rev-parse HEAD 2>/dev/null); then
        # Uncommitted edits to tracked files change the build too.
        printf '%s+%s' "$head" "$(git -C "$workspace" diff HEAD 2>/dev/null | sha256_stdin)"
    elif [[ -f "$workspace/.repo-commit" ]]; then
        tr -d '[:space:]' < "$workspace/.repo-commit"
    else
        printf 'unknown'
    fi
}

compute_fingerprint() {
    {
        printf 'repo=%s\n' "$(repo_version)"
        if [[ "$input_kind" == image ]]; then
            printf 'image=%s|%s\n' "$input" "$(file_stat_id "$input")"
        else
            printf 'dol=%s\n' "$(sha256_stdin < "$input/sys/main.dol")"
            if [[ -f "$input/files/rel/StaticR.rel" ]]; then printf 'rel=%s\n' "$(sha256_stdin < "$input/files/rel/StaticR.rel")"; fi
        fi
        if [[ -n "$retro_root" ]]; then
            printf 'rr-pul=%s\n' "$(sha256_stdin < "$retro_root/Binaries/Code.pul")"
            printf 'rr-tree=%s|%s\n' "$(find "$retro_root" -type f | wc -l | tr -d ' ')" "$(du -sk "$retro_root" | awk '{print $1}')"
        else
            printf 'rr=none\n'
        fi
    } | sha256_stdin
}

fingerprint=$(compute_fingerprint)
built_fingerprint=""
if [[ -f "$out_dir/$FINGERPRINT_FILE" ]]; then built_fingerprint=$(tr -d '[:space:]' < "$out_dir/$FINGERPRINT_FILE"); fi

site_complete() {
    [[ -f "$out_dir/index.html" && -f "$out_dir/products.json" && -f "$out_dir/disc-manifest.json" ]]
}

if (( ! force_rebuild )) && [[ "$built_fingerprint" == "$fingerprint" ]] && site_complete; then
    say ""
    say "web/dist is up to date for these game files and this version; skipping the build."
    say "(Use --rebuild to build again.)"
    [[ "$mode" == build-only ]] && exit 0
    serve
fi

# ---------------------------------------------------------------------------
# Prerequisites (only needed to build)
# ---------------------------------------------------------------------------
missing=()
note_missing() { missing+=("$1"); }

if ! command -v emcc >/dev/null 2>&1 && [[ -n "${EMSDK:-}" && -f "$EMSDK/emsdk_env.sh" ]]; then
    # shellcheck disable=SC1091
    EMSDK_QUIET=1 source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1 || true
fi
command -v emcc >/dev/null 2>&1 || note_missing "Emscripten $EMSCRIPTEN_RECOMMENDED:  git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install $EMSCRIPTEN_RECOMMENDED && ./emsdk activate $EMSCRIPTEN_RECOMMENDED
       then run 'source emsdk_env.sh' (or export EMSDK=/path/to/emsdk) before web/host.sh"
if command -v dotnet >/dev/null 2>&1; then
    dotnet --list-sdks 2>/dev/null | grep -Eq '^8\.' || note_missing ".NET 8 SDK (a different version is installed):  https://dotnet.microsoft.com/download/dotnet/8.0"
else
    note_missing ".NET 8 SDK:  https://dotnet.microsoft.com/download/dotnet/8.0"
fi
command -v cmake >/dev/null 2>&1 || note_missing "CMake 3.25 or newer:  https://cmake.org/download/  (apt install cmake / brew install cmake)"
command -v ninja >/dev/null 2>&1 || note_missing "Ninja:  apt install ninja-build / brew install ninja"
command -v python3 >/dev/null 2>&1 || note_missing "Python 3:  https://www.python.org/downloads/"
if [[ "$input_kind" == image ]]; then
    if [[ -z "${MKW_DISC_EXTRACT_CMD:-}" ]] && ! command -v nodtool >/dev/null 2>&1 && [[ -z "${NODTOOL:-}" ]] \
        && [[ ! -x "$workspace/Launcher/artifacts/nodtool" ]] \
        && ! command -v DolphinTool >/dev/null 2>&1 && ! command -v dolphin-tool >/dev/null 2>&1; then
        note_missing "nodtool (disc extractor):  download it from https://github.com/encounter/nod/releases/tag/$NODTOOL_VERSION,
       put it on PATH (or set NODTOOL=/path/to/nodtool). Or drop an already extracted game folder instead of an image."
    fi
fi

if [[ ${#missing[@]} -gt 0 ]]; then
    {
        say ""
        say "Building needs a few tools that are not installed here:"
        n=0
        for m in "${missing[@]}"; do n=$((n + 1)); printf '  %d. %s\n' "$n" "$m"; done
        say ""
        say "Easier: skip all of that and use Docker, which has everything built in:"
        say "    docker compose up        (run from the repository root; reads the same web/game folder)"
    } >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
build_args=("$input" --out "$out_dir")
[[ -z "$retro_root" ]] || build_args+=(--retro-rewind "$retro_root")
[[ -z "$jobs" ]] || build_args+=(--jobs "$jobs")

say ""
say "Building (the first build translates and compiles the whole game and can take a long time;"
say "later runs reuse it). Progress follows."
rm -f "$out_dir/$FINGERPRINT_FILE"   # a half-built site must never count as current
if ! "${MKW_BUILD_SCRIPT:-$script_dir/build.sh}" "${build_args[@]}"; then
    {
        say ""
        say "The build failed (see the messages above)."
        say "Common causes: not an unmodified PAL (RMCP01) copy of Mario Kart Wii, or too little RAM (try --jobs 2)."
    } >&2
    exit 1
fi
printf '%s\n' "$fingerprint" > "$out_dir/$FINGERPRINT_FILE"

if [[ "$mode" == build-only ]]; then
    say ""
    say "Build finished: $out_dir"
    exit 0
fi
serve
