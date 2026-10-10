#!/usr/bin/env bash
# Game-data-free smoke test of the real web product startup.
#
#   web/tests/smoke/run_smoke.sh [--work DIR] [--jobs N] [--port N] [--timeout SECONDS]
#                                [--frames N] [--cmake-args-file FILE] [--skip-gen] [--skip-build]
#                                [--only-build]
#
# 1. make_synthetic_generated.py: the real translator on a tiny synthetic DOL -> generated/
#    (outside the repository, under --work).
# 2. emcmake + ninja: the real runtime + aurora product graph (runtime/cmake/PublicProducts.cmake)
#    linked into WiiCompiled.js/.wasm against that synthetic translation.
# 3. The real page (web/site) served by web/serve.py, driven in headless Chromium by
#    smoke_test.mjs: click to start, JSPI main, SDL/aurora/WebGPU on #canvas, config under $HOME,
#    embedded /app assets, then the synthetic entry point presents --frames N frames (default 600)
#    through the runtime's GXInit/GXCopyDisp HLE (the driver starts the page hidden with a 0x0
#    canvas and hides it again mid-run: docs/web-test-report.md C2/C3), then calls DVDInit, which
#    stops with the runtime's "DVD data is unavailable" fatal report (no disc is configured).
#    --frames 0 skips the frame loop and the visibility checks. Changing --frames needs a new
#    translation (not --skip-gen).
#
# Prints the furthest startup milestone reached and exits 0 only if startup reached the expected
# disc-data stop cleanly (no trap, abort, hang or JS exception before it).
#
# --cmake-args-file: whitespace-separated extra configure arguments (e.g. the
# FETCHCONTENT_SOURCE_DIR_* overrides of an offline machine); SMOKE_CMAKE_ARGS works too.
# Environment: EMSDK (default /opt/emsdk), PLAYWRIGHT_MODULE, CHROMIUM_PATH.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../../.." && pwd)
work="$repo/build/web-smoke"
jobs=2
port=0
timeout=180
frames=600
skip_gen=0
skip_build=0
only_build=0
extra_cmake_args=${SMOKE_CMAKE_ARGS:-}

while (($#)); do
    case "$1" in
        --work) work=$2; shift 2 ;;
        --jobs) jobs=$2; shift 2 ;;
        --port) port=$2; shift 2 ;;
        --timeout) timeout=$2; shift 2 ;;
        --frames) frames=$2; shift 2 ;;
        --cmake-args-file) extra_cmake_args="$extra_cmake_args $(cat "$2")"; shift 2 ;;
        --skip-gen) skip_gen=1; shift ;;
        --skip-build) skip_build=1; shift ;;
        --only-build) only_build=1; shift ;;
        -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
mkdir -p "$work"
work=$(cd "$work" && pwd)
gen="$work/gen"
build="$work/wasm"
dist="$work/dist"

step() { printf '\n==> %s\n' "$*"; }

if ! command -v emcc >/dev/null 2>&1; then
    # shellcheck disable=SC1091
    source "${EMSDK:-/opt/emsdk}/emsdk_env.sh" >/dev/null 2>&1
fi

if ((!skip_gen)); then
    step "Synthetic translation (real translator, synthetic DOL) -> $gen"
    python3 "$here/make_synthetic_generated.py" "$gen" --workspace "$repo" --frames "$frames"
fi

if ((!skip_build)); then
    step "Configuring $build"
    # shellcheck disable=SC2086
    emcmake cmake -S "$repo/runtime" -B "$build" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DMKW_TRANSLATED_SHARD_MANIFEST="$gen/generated/build_shards/shards.cmake" \
        -DMKW_GENERATED_ROOT="$gen" \
        -DMKW_TRANSLATED_COMPILE_JOBS=1 \
        -DMKW_PLATFORM_WEB_DIST="$dist" \
        $extra_cmake_args
    step "Building WiiCompiled (ninja -j$jobs)"
    cmake --build "$build" --target WiiCompiled --parallel "$jobs"
fi

step "Assembling $dist"
mkdir -p "$dist"
cp -R "$repo/web/site/." "$dist/"
for f in WiiCompiled.js WiiCompiled.wasm; do
    [[ -f "$dist/$f" ]] || cp -f "$build/$f" "$dist/$f"
done
ls -l "$dist/WiiCompiled.js" "$dist/WiiCompiled.wasm"
((only_build)) && exit 0

if ((port == 0)); then port=$((18000 + RANDOM % 2000)); fi
step "Serving $dist on http://127.0.0.1:$port/"
python3 "$repo/web/serve.py" --dir "$dist" --port "$port" -q &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT

step "Driving headless Chromium"
log="$work/smoke-console.log"
node "$here/smoke_test.mjs" "http://127.0.0.1:$port/" "$log" "$timeout" "$frames"
