#!/usr/bin/env bash
# Builds web/tests/web_disc_test.cpp (web disc layer + IDBFS save store) and
# web/tests/web_riivolution_test.cpp (Riivolution over a streamed mod pack) and runs them under Node
# (JSPI) and headless Chromium against generated fake trees. No game data involved.
# usage: web/tests/run_web_disc_test.sh [out_dir] [--no-node] [--no-browser]
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${TMPDIR:-/tmp}/mkw-web-disc-test-build"
if [[ $# -gt 0 && "$1" != --* ]]; then out="$1"; shift; fi
mkdir -p "$out"
if ! command -v em++ >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  source "${EMSDK:-/opt/emsdk}/emsdk_env.sh" >/dev/null 2>&1
fi

cd "$repo"
common=(-std=c++20 -O2 -Wall -Wextra -fwasm-exceptions -sSUPPORT_LONGJMP=wasm
  -sJSPI -sJSPI_EXPORTS=main -sALLOW_MEMORY_GROWTH -sMODULARIZE -sEXPORT_ES6
  --js-library web/js/library_mkw_dvd.js -lidbfs.js -Iruntime/include)

em++ "${common[@]}" -sEXPORT_NAME=createWebDiscTest \
  web/tests/web_disc_test.cpp runtime/src/hle/storage/web_disc.cpp \
  -o "$out/web_disc_test.mjs"

# The real riivolution.cpp (+ its XML contract and pugixml) against a streamed fake pack; the
# test file supplies the few product-link symbols it needs.
em++ "${common[@]}" -w -DTARGET_PC -msimd128 -msse4.2 -mavx2 -sEXPORT_NAME=createWebRiivolutionTest \
  -Iruntime/src -I. -Iruntime/third_party/toml11 -Iruntime/third_party/pugixml -Iruntime/third_party \
  web/tests/web_riivolution_test.cpp runtime/src/hle/storage/riivolution.cpp \
  runtime/src/hle/storage/web_disc.cpp runtime/third_party/pugixml/pugixml.cpp \
  -o "$out/web_riivolution_test.mjs"

node_bin="${MKW_RUNNER_NODE:-$(command -v node)}"
exec "$node_bin" web/tests/run_web_disc_test.mjs "$out" "$@"
