#!/usr/bin/env bash
# Browser input tests, no game data and no hardware.
#
#   web/tests/input/run_input_test.sh [--work DIR] [--jobs N] [--skip-build] [--shots DIR]
#                                     [--cmake-args-file FILE]
#
# 1. pad_merge_test.cpp (native c++): the keyboard + gamepad merge and the default keyboard layout.
# 2. check_layout_sync.mjs: web/site/main.js KEYBOARD_LAYOUT is the C++ table.
# 3. emcmake + ninja: input_harness.cpp (aurora + runtime/src/platform/web/web_input.cpp +
#    web/js/library_mkw_input.js) as WiiCompiled.js/.wasm, hosted by the real page.
# 4. input_test.mjs: headless Chromium with fake gamepads and real key events.
#
# --cmake-args-file: extra configure arguments (e.g. FETCHCONTENT_SOURCE_DIR_* of an offline
# machine); INPUT_CMAKE_ARGS works too. Environment: EMSDK (default /opt/emsdk), CXX (native
# compiler, default c++), SDL3_INCLUDE (SDL3 headers for the native test; default: the harness
# build's SDL source), PLAYWRIGHT_MODULE, CHROMIUM_PATH.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../../.." && pwd)
work="$repo/build/web-input-test"
jobs=2
skip_build=0
shots=""
extra_cmake_args=${INPUT_CMAKE_ARGS:-}

while (($#)); do
    case "$1" in
        --work) work=$2; shift 2 ;;
        --jobs) jobs=$2; shift 2 ;;
        --skip-build) skip_build=1; shift ;;
        --shots) shots=$2; shift 2 ;;
        --cmake-args-file) extra_cmake_args="$extra_cmake_args $(cat "$2")"; shift 2 ;;
        -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
mkdir -p "$work"
work=$(cd "$work" && pwd)
build="$work/wasm"
site="$work/site"
step() { printf '\n==> %s\n' "$*"; }

if ! command -v emcc >/dev/null 2>&1; then
    # shellcheck disable=SC1091
    source "${EMSDK:-/opt/emsdk}/emsdk_env.sh" >/dev/null 2>&1
fi

if ((!skip_build)); then
    step "Configuring the input harness ($build)"
    # shellcheck disable=SC2086
    emcmake cmake -S "$here" -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release $extra_cmake_args >/dev/null
fi

sdl_include=${SDL3_INCLUDE:-}
if [[ -z "$sdl_include" ]]; then
    sdl_include=$(sed -n 's/^FETCHCONTENT_SOURCE_DIR_SDL:PATH=//p' "$build/CMakeCache.txt" 2>/dev/null || true)
    [[ -n "$sdl_include" ]] || sdl_include="$build/_deps/sdl-src"
    sdl_include="$sdl_include/include"
fi

step "Native unit test (merge + default layout)"
"${CXX:-c++}" -std=c++20 -DTARGET_PC -I"$repo/aurora-main/include" -I"$repo/aurora-main/lib" \
    -I"$repo/runtime/include" -I"$sdl_include" "$here/pad_merge_test.cpp" -o "$work/pad_merge_test"
"$work/pad_merge_test"

step "Page layout copy"
"$work/pad_merge_test" --layout-json > "$work/layout.json"
node "$here/check_layout_sync.mjs" "$work/layout.json"

if ((!skip_build)); then
    step "Building the input harness (ninja -j$jobs)"
    cmake --build "$build" --target WiiCompiled --parallel "$jobs"
fi

step "Assembling $site"
rm -rf "$site"
mkdir -p "$site"
cp -R "$repo/web/site/." "$site/"
cp "$build/WiiCompiled.js" "$build/WiiCompiled.wasm" "$site/"

step "Headless Chromium"
node "$here/input_test.mjs" "$site" ${shots:+--shots "$shots"}
