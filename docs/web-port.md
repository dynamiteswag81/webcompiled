# WiiCompiled for the Web (WebAssembly + WebGPU)

Status: **in progress**. This document is the design and work plan for the browser
port. It is written so that any contributor (human or agent) can pick up a task
without re-deriving the analysis.

> Game data rule: nothing derived from the disc (main.dol, StaticR.rel, the
> `generated/` C++ the translator emits from them, extracted `files/`, or any
> `.wasm` built from them) is ever committed. Each user translates and builds
> locally from their own PAL `RMCP01` copy of the game, exactly like the native setup.
> Everything in this repo must build/test without game data, except the final
> product link.

## Toolchain

| Tool | Version used | Notes |
| --- | --- | --- |
| Emscripten (emsdk) | 6.0.12 | `-sJSPI` is non-experimental in this release |
| .NET SDK | 8.0 | translator only (unchanged) |
| CMake + Ninja | ≥3.25 | `emcmake cmake -G Ninja` |
| Browser | Chrome/Edge 137+ (JSPI + WebGPU) | Firefox once JSPI + WebGPU both ship |

## Architecture decisions

### 1. Guest memory → checked page-table path
Native builds reserve a fixed 4 GiB host range and use page protection to trap
MMIO, EFB deferred reads and executable-page writes
(`runtime/include/guest_flat_memory.h`). WASM has neither fixed addresses nor
page protection.

The runtime already has a portable fallback for AArch64 hosts with >4 KiB
pages: `GuestFlat::RequiresCheckedAccess()` routes `FlatRead*/FlatWrite*`
through `Memory::Read*/Write*` (1 MiB page-bias tables + slow paths). The web
build:

* adds `runtime/src/guest_flat_memory_wasm.cpp` (malloc-backed MEM1/MEM2 stores,
  `HostPointer` via mapping list, protections are no-ops), modelled on
  `guest_flat_memory_macos.cpp`;
* makes `RequiresCheckedAccess()` a `constexpr true` under `__EMSCRIPTEN__`;
* replaces the raw `MKW_FLAT_GUEST_BASE + addr` in `FlatLoad/FlatStore`
  (used by the translator-proven `FlatWriteRam*` stack stores) with the
  page-bias table, since there is no flat base.

`uintptr_t` is 32-bit in wasm32; the encoded bias arithmetic is modular and
still correct.

### 2. Guest threads → JSPI coroutines
Guest `OSThread`s are cooperative fibers behind the tiny `HostContext`
interface (`runtime/include/host_context.h`: `InitializeScheduler`, `Create`,
`Destroy`, `IsCurrent`, `Switch`). Emscripten's own fibers require Asyncify,
which would instrument ~28k translated functions (huge size/speed cost), so the
web backend implements `HostContext` on **JSPI**:

* each context owns a malloc'd C shadow stack;
* `Switch(target)` saves the current `__stack_pointer`, calls a suspending JS
  import that resolves `target`'s pending promise (or starts it through a
  `WebAssembly.promising` export the first time), and awaits its own promise;
* on resume it restores its own stack pointer/limits.

Requirements this places on the build:
* `-fwasm-exceptions` (JS-based exception `invoke_*` trampolines would put JS
  frames between the promising export and the suspend point → JSPI trap);
* `-sSUPPORT_LONGJMP=wasm`;
* no guest-reachable code path may be entered from a JS callback (SDL event
  callbacks, etc.) — game code only ever runs under `main`.

### 3. Yielding to the browser
The game never returns from its entry point. The runtime's precise waits
(`SleepPreciselyUntil`/`PaceToRetraceBoundary` in `runtime/src/hle/vi.cpp`,
`os_sleep`, GX frame waits) become JSPI suspensions:
* `ms > 4` → `setTimeout`,
* otherwise → `MessageChannel` post (avoids the nested-setTimeout 4 ms clamp).

A yield is also forced after every `aurora_end_frame()` so the canvas is
presented and input events are delivered even when frames run late.

### 4. Host threads → single-threaded
| Native thread | Web replacement |
| --- | --- |
| aurora frame worker (`lib/aurora.cpp`) | `frame_worker_requested()` → false (sync path already exists for macOS) |
| aurora presenter | present inline |
| aurora pipeline compile workers + cache writer | compile synchronously; no sqlite cache (or IDBFS later) |
| frame interpolation workers | interpolation disabled |
| AX mix worker (`hle/audio/ax_mix.cpp`) | mix inline on the guest thread |
| network deferred worker | networking disabled (no raw sockets in browsers) |
| music attenuation / discord / stdout transcript | compiled out |

### 5. Graphics → aurora on browser WebGPU
aurora talks to Dawn's `webgpu_cpp.h`. Emscripten's `--use-port=emdawnwebgpu`
provides the same C++ API backed by `navigator.gpu`. Dawn-native-only pieces
(`dawn::native` instance, `DawnTogglesDescriptor`, `DawnCacheDeviceDescriptor`,
blob cache, MetalFX, adapter enumeration, blocking `WaitAny` with timeouts)
get `__EMSCRIPTEN__` branches. Surface comes from the `#canvas` selector
(`wgpu::EmscriptenSurfaceSourceCanvasHTMLSelector`). Adapter/device requests
are async → awaited through JSPI. Shaders are already generated as WGSL.

SDL3 is built from source with its Emscripten backend (window, keyboard,
gamepad API, audio).

### 6. Disc access
`runtime/src/hle/storage/dvd.cpp` reads host files under the DVD root. On the
web the extracted `DATA/` tree is served next to the page by the local server;
reads become JSPI-awaited HTTP `Range` fetches with an in-memory LRU cache.
NAND saves go to IDBFS (persisted in IndexedDB).

### 7. Serving
JSPI does not need `SharedArrayBuffer`, so no COOP/COEP is strictly required.
`web/serve.py` serves `web/dist` plus the user's extracted `DATA/` with Range
support on `http://localhost:8080`.

## Deployment target (product spec)

The repo never contains game data. The deliverable is a pipeline where an
**operator** supplies their own PAL `RMCP01` copy of the game (ISO/RVZ/WBFS/...) and runs
one command (`web/build.ps1` / `web/build.sh`) that extracts, translates,
compiles to wasm and writes a **self-contained static site** (`web/dist/`):
`index.html`, `.js`, `.wasm`, and the extracted disc tree. Any static web
server that supports HTTP `Range` (nginx, Caddy, GitHub-Pages-style hosts,
the bundled `web/serve.py` for local use) can host it, and **clients just open
the URL and play**: no install, no per-client game file.

Consequences:
* No `SharedArrayBuffer`/COOP/COEP requirement (JSPI, single-threaded), so it
  works on plain static hosting.
* Disc reads stream lazily over HTTP Range from the hosted extracted tree (with
  an in-memory cache), so first load is not a multi-GB download. A build-time
  `disc-manifest.json` (path → size) replaces directory scans.
* Saves/config live per client in IndexedDB (IDBFS).
* Optional later: a "bring your own disc" mode where the client picks a local
  image/folder (File System Access API) when the operator hosts no data.

## Ownership

The cloud session owns all remaining work (it has no game data, so it cannot
run the translator on the disc or link the final product, but it builds and
tests everything else). The local session (with the user's game files) is recalled
later only to run the full pipeline end to end and debug against the real game.

## Status

Last updated by the cloud session. "Verified" means run here, without game data,
unless it says "local" (verified by the local session with the real game files).

### Verified
* **Translator on the real PAL game files (local):** 29,637 functions in ~30 s;
  `emit-base-manifest`, `generate-data-init`, `emit-build-shards` succeed
  → 72 `base_common` shards + dispatch + 16 registration TUs (~427 MB C++).
* **One translated shard compiles with em++ (local)** in ~14 s (1.8 MB object)
  with the same flags the web product graph now uses for shards
  (`-O2 -fno-fast-math -ffp-contract=off -fno-slp-vectorize -fwasm-exceptions
  -sSUPPORT_LONGJMP=wasm -msimd128 -msse4.2 -mavx2 -DTARGET_PC`).
* **JSPI HostContext backend:** `web/tests/host_context_test.cpp` prints `PASS`
  under Node 24 (local). Build: `em++ -std=c++20 -O2 -fwasm-exceptions -sJSPI
  -sJSPI_EXPORTS=main,mkw_host_context_entry --js-library
  web/js/library_mkw_host.js -Iruntime/include web/tests/host_context_test.cpp
  runtime/src/host_context.cpp -o test.js && node test.js`.
* **aurora in the browser:** `aurora-main/examples/simple` (built with emcmake,
  see "aurora web notes") renders its GX clear colour through browser WebGPU in
  headless Chromium 141 (SwiftShader adapter), single-threaded, under JSPI.
* **Runtime compiles for wasm:** every `runtime/src` TU except `abi_bridge.cpp`
  and `hle/os/os_alarm.cpp` (they include translator output) compiles with
  em++ 6.0.12 via the `mkw_web_runtime_compile` audit target:
  `emcmake cmake -S runtime -B build-rt -G Ninja -DCMAKE_BUILD_TYPE=Release
  -DMKW_BUILD_PRODUCTS=OFF && ninja -C build-rt mkw_web_runtime_compile`.
  Edited files still compile natively (clang++ `-fsyntax-only`, x86-64-v3).
* **The real web product boots (no game data):** `web/tests/smoke/run_smoke.sh`
  runs the real translator on a tiny synthetic DOL
  (`web/tests/smoke/make_synthetic_generated.py`), links `WiiCompiled.wasm`
  through the real product graph (no undefined-symbol stubs), serves it with the
  real page and `web/serve.py`, and drives headless Chromium: config load,
  WebGPU adapter/device/surface, `_init` sections, the translated entry point,
  then a clean stop at DVDInit with the report in the page's error overlay (no
  trap, abort or hang). ~10 min cold build at `-j2`; 7.9 MB wasm.
* **Disc streaming and saves:** `web/tests/run_web_disc_test.sh` (Node 24 with
  JSPI, plus headless Chromium): 104+ checks on a generated fake disc (random
  and cross-block reads, EOF/short reads, LRU cache, coalesced Range requests,
  404/truncated/no-Range servers, manifest listings) and IDBFS saves surviving a
  reload.
* **Canvas sizing:** the drawing buffer follows the canvas CSS size ×
  devicePixelRatio (600×300 CSS at DPR 2 → 1200×600).
* **Translator `#embed` companions:** `dotnet test` 645/645; the emitted
  `data_sections_init_blobs.cpp` compiles with em++ and its bytes read back
  equal to the `.bin` files under Node.
* **Site tooling:** `web/serve.py` (Range/416/HEAD/MIME) passes
  `python3 -m unittest discover -s web/tests -p 'test_*.py'` (18 tests);
  the page passes `node web/tests/frontend_test.mjs` (Playwright, headless
  Chromium: compat check, download progress, start gate, help, error overlay,
  phone width).

### Done (code in this branch)
* ISA/FP/memory headers for wasm (`MKW_HOST_X86_SIMD`, no `-mfma`, software FP
  control word, page-table guest memory); `guest_flat_memory_wasm.cpp`.
* JSPI `HostContext` + `web/js/library_mkw_host.js` (`mkw_host_context_switch`,
  `mkw_host_yield`).
* aurora for Emscripten (see "aurora web notes").
* Runtime: `MKW_PLATFORM_WEB` CMake path; networking always off (no TLS, no
  sockets); Discord presence and TLS replaced by `src/platform/web/` stubs; AX
  mixing inline; no transcript threads; graphics API table `{"auto"}`; sleeps
  in VI pacing, GX frame retry and `GKI_delay` suspend through
  `platform/web_host.h` (`WebHost::SleepUntil/SleepFor/Yield`), plus one yield
  after every `aurora_end_frame()`; executable directory `/app` (embedded
  `dsp_coef.bin`, `wii_bootstrap/`), app data under `$HOME`
  (`/home/web_user`).
* Product link (`runtime/cmake/PublicProducts.cmake`, `mkw_configure_web_product`):
  `-sJSPI -sJSPI_EXPORTS=main,mkw_host_context_entry`, every `web/js/*.js` as
  `--js-library`, `-lidbfs.js`, `-sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=4GB
  -sSTACK_SIZE=8MB -sENVIRONMENT=web`, `--embed-file` for `/app`;
  `-DMKW_PLATFORM_WEB_DIST=<dir>` copies `WiiCompiled.js/.wasm` there.
  Translated `.S` blobs are replaced by the translator's `#embed` companions
  (`data_sections_init_blobs.cpp`, `mod_data_patches_blobs.cpp`); never both.
* `web/build.sh`, `web/build.ps1`, `web/serve.py`, `web/site/` (see the spec).

* Disc over HTTP Range (`runtime/src/hle/storage/web_disc.cpp`,
  `web/js/library_mkw_dvd.js`): the extracted DATA tree is served at
  `disc/` with `disc-manifest.json` (`web/tools/make_disc_manifest.py`);
  the runtime sees it at the virtual path `/disc`; 256 KiB blocks, 64 MiB LRU,
  coalesced requests up to 16 MiB, retries. Page options:
  `Module.mkwDiscManifestUrl`, `mkwDiscBaseUrl`, `mkwDiscRetries`.
* Saves: IDBFS on `/home/web_user`, mounted before `main`, synced after file
  writes and when the page is hidden. Run logs go to `/tmp` (not persisted).
* Fatal reports reach the page (`mkw_host_report_fatal` → `Module.onMkwFatal`).

### In progress
* Drop-in hosting: `web/host.sh` / `host.ps1` (drop a disc image or extracted
  tree into `web/game/`, build once with a cached fingerprint, serve),
  `compose.yaml` + `web/docker/Dockerfile`.
* Retro Rewind: the build-script leg (`translate-mod`, `RetroRewind` target,
  `dist/mods/RetroRewind6/` + manifest, `products.json`), the start-screen
  product choice, and the runtime mount of the pack (streamed like the disc).

### Needs the real game (local session)
* Full pipeline end to end: `web/build.sh <image>` (or `build.ps1`, which has
  not been parsed by PowerShell yet), then play from `web/serve.py`.
* V8 limits on the largest translated functions (function body size, locals),
  JSPI secondary-stack depth for deep guest call chains, and link time/size of
  the 427 MB shard set.
* Gameplay: rendering correctness on browser WebGPU, audio, input (keyboard map
  is a placeholder in the help overlay), save persistence across reloads,
  pacing at 60 Hz with browser timers.

## aurora web notes

Build: `emcmake cmake -S aurora-main -B build-web -G Ninja
-DCMAKE_BUILD_TYPE=Release && ninja -C build-web simple`, then serve
`build-web/examples/` over http://127.0.0.1 and open `simple.html`
(Chrome/Edge 137+; WebGPU needs a secure context).

* CMake (`EMSCRIPTEN`): `dawn::webgpu_dawn` is an interface target over
  `--use-port=emdawnwebgpu`; all deps static; `-fwasm-exceptions
  -sSUPPORT_LONGJMP=wasm` for every target; zstd without threads; fmt gets
  `<cstdlib>`; aurora's tests are not built.
* imgui's WebGPU backend is built through `lib/imgui_impl_wgpu_web.cpp` (its
  Dawn path against emdawnwebgpu; v1.91.9 only knows the removed legacy
  Emscripten bindings).
* `gpu.cpp`: no Dawn-native instance descriptor, toggles, blob cache, logging
  callback, ImplicitDeviceSynchronization or MetalFX features; adapter request
  without a backend type; canvas offers only Fifo. Adapter/device/map waits use
  `WaitAny` (TimedWaitAny) and suspend through JSPI.
* Surface from SDL's canvas selector (`SDL_PROP_WINDOW_EMSCRIPTEN_CANVAS_ID_STRING`,
  default `#canvas`); `SDL_WINDOW_HIGH_PIXEL_DENSITY` gives CSS size ×
  devicePixelRatio.
* Single-threaded: no frame worker, presenter, pipeline workers, sqlite
  pipeline cache or frame interpolation (forced off). Pipelines compile
  synchronously on first use.
* Presentation: no `Surface::Present()` (the browser presents when control
  returns), and no spin to the present deadline (the caller paces).
* `begin_frame` suspends on the staging-buffer map future via `WaitAny`
  instead of spinning `ProcessEvents()` (the map resolves on the JS event loop).
* The example yields with `requestAnimationFrame` through `EM_ASYNC_JS`; the
  game yields from its VI pacing instead.
* Gaps: no pipeline cache across reloads (the browser's own shader cache
  helps); no MSAA/upscaler tuning for the web; Dawn validation messages are not
  forwarded (no logging callback in emdawnwebgpu).

## Work plan

1. [x] `web/build.sh` / `web/build.ps1` (extract → translate → emcmake → dist).
2. [x] aurora: Emscripten build, validated with its own example.
3. [x] runtime: wasm guest memory backend.
4. [x] runtime: JSPI `HostContext` backend + JS library.
5. [x] runtime: single-threaded audio mixing, networking off, platform stubs,
       app paths (`/app`, `$HOME`).
6. [x] runtime: x86/SSE paths → Emscripten SSE/AVX2 compat, software FP env.
7. [x] DVD over HTTP Range + IDBFS NAND.
8. [ ] Link translated shards (needs the real game; watch V8 limits).
9. [x] Frontend page: canvas, loading/progress, controls help, error overlay.
10. [ ] Performance pass (`-O3`, LTO decisions, code size).
