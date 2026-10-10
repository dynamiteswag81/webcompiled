#!/usr/bin/env bash
# Builds web/tests/web_disc_test.cpp (web disc layer + IDBFS save store) and runs it under Node
# (JSPI) and headless Chromium against a generated fake disc tree. No game data involved.
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
em++ -std=c++20 -O2 -Wall -Wextra -fwasm-exceptions -sSUPPORT_LONGJMP=wasm \
  -sJSPI -sJSPI_EXPORTS=main -sALLOW_MEMORY_GROWTH \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createWebDiscTest \
  --js-library web/js/library_mkw_dvd.js -lidbfs.js \
  -Iruntime/include \
  web/tests/web_disc_test.cpp runtime/src/hle/storage/web_disc.cpp \
  -o "$out/web_disc_test.mjs"

node_bin="${MKW_RUNNER_NODE:-$(command -v node)}"
exec "$node_bin" web/tests/run_web_disc_test.mjs "$out" "$@"
