# WiiCompiled for the Web (WebAssembly + WebGPU)

Status: **in progress**. This document is the design and work plan for the browser
port. It is written so that any contributor (human or agent) can pick up a task
without re-deriving the analysis.

> Game data rule: nothing derived from the disc (main.dol, StaticR.rel, the
> `generated/` C++ the translator emits from them, extracted `files/`, or any
> `.wasm` built from them) is ever committed. Each user translates and builds
> locally from their own PAL `RMCP01` dump, exactly like the native setup.
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
**operator** supplies their own PAL `RMCP01` dump (ISO/RVZ/WBFS/...) and runs
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
run the translator or link the final product, but it can build and test
everything else). The local session (with the user's dump) is recalled later
only to run the full pipeline end to end and debug against the real game.

## Status (handover from the local session)

Verified locally with the real dump (outputs are gitignored, not in the repo):
* Translator on the clean PAL dump: 29,637 functions in ~30 s;
  `emit-base-manifest`, `generate-data-init`, `emit-build-shards` all succeed
  → 72 `base_common` shards + dispatch + 16 registration TUs (~427 MB C++).
* One translated shard compiles with em++ 6.0.12 in ~14 s (1.8 MB object) using:
  `-std=c++17 -O2 -fno-fast-math -ffp-contract=off -fno-slp-vectorize -w
  -fwasm-exceptions -msimd128 -msse4.2 -mavx2 -DTARGET_PC
  -Iruntime/include -Iruntime/src -I<repo root> -Iaurora-main/include`.
* **JSPI HostContext backend works**: `web/tests/host_context_test.cpp`
  (3 contexts ping-ponging, separate shadow stacks, 2000-deep recursion, C++
  exceptions, `mkw_host_yield`) prints `PASS` under Node 24. Build:
  `em++ -std=c++20 -O2 -fwasm-exceptions -sJSPI
  -sJSPI_EXPORTS=main,mkw_host_context_entry --js-library
  web/js/library_mkw_host.js -Iruntime/include web/tests/host_context_test.cpp
  runtime/src/host_context.cpp -o test.js && node test.js`.

Done in this branch:
* `ppc_isa_config.h`: wasm reuses the x86 SIMD formulations via Emscripten's
  SSE/AVX2 compat headers (`MKW_HOST_X86_SIMD`); **no `-mfma`** on purpose
  (Emscripten's `_mm_fmadd_ps` would be an unfused mul+add; without `__FMA__`
  the code takes its correctly-rounded scalar `fmaf` path).
* `ppc_isa_fpenv.h`: software FP-control word on wasm (no FTZ/DAZ hardware;
  explicit NI flush points still honored).
* `guest_flat_memory.h` / `memory_access.h` / `ppc_isa_quantized.h`: no flat
  base on wasm; `RequiresCheckedAccess()` is constexpr true; `ResolveRangeHost`
  and the psq fast paths resolve through the 1 MiB page-bias tables;
  `FlatWriteRam*` use the writable-bias fast path.
* `host_context.cpp`: `__EMSCRIPTEN__` JSPI backend + `web/js/library_mkw_host.js`
  (`mkw_host_context_switch`, `mkw_host_yield`).

Known remaining compile errors from `em++ -fsyntax-only` over `runtime/src`:
* SDL3 headers (`SDL3/SDL_events.h`, `SDL_gamepad.h`, `SDL_audio.h`): come with
  aurora's SDL3 once aurora builds for Emscripten (or `--use-port=sdl3` meanwhile).
* `runtime_config.h` `IsSupportedGraphicsApi`: no `values` table for
  Emscripten (it defines neither `__linux__` nor `_WIN32`); add `{"auto"}`.
  Same check for main.cpp's `kGraphicsBackends`.
* `discord_presence.cpp` (`timeval`), `network_ssl.cpp` (mbedtls),
  `music_attenuation.cpp`: compile out on the web.
* `guest_flat_memory.cpp`: exclude; add `guest_flat_memory_wasm.cpp`
  (malloc-backed stores, modelled on `guest_flat_memory_macos.cpp`).
* `generated/data_sections_init_blobs.S` is COFF asm with `.incbin`; on wasm
  emit/convert it to C with `#embed` (or a generated byte array).

Notes for the remaining runtime work:
* Paths: under Emscripten the generic POSIX branches apply (`$HOME` =
  `/home/web_user`); mount IDBFS there for config/NAND persistence.
* Sleeps: `SleepPreciselyUntil`/`PaceToRetraceBoundary` (hle/vi.cpp),
  `sleep_for` in gx_frame.cpp/os_init.cpp/os_reset.cpp must call
  `mkw_host_yield` (libc `nanosleep` busy-waits on the main thread). Force a
  yield after every `aurora_end_frame()` so the canvas presents.
* DVD: all reads go through `DvdReadContract::ReadExact` (hle/dvd_contract.h)
  plus `fs::` scans in dvd.cpp → web backend over the manifest + Range fetch.
* Host threads to make inline/off: AX mix worker (ax_mix.cpp), network
  deferred worker, main.cpp transcript pipes/threads, music attenuation.
* Watch V8 limits: per-function body size/locals in huge translated
  functions, and JSPI secondary-stack depth for deep guest call chains.

## Work plan

1. [ ] `web/` CMake toolchain wrapper + `web/build.ps1` / `build.sh`
       (extract → translate → emcmake configure → ninja → dist).
2. [ ] aurora: Emscripten build (SDL3 vendored, emdawnwebgpu, threads off).
       Validate with aurora's own example (no game data needed).
3. [ ] runtime: wasm guest memory backend.
4. [ ] runtime: JSPI `HostContext` backend + JS library.
5. [ ] runtime: single-threaded audio mixing, networking off, platform stubs
       (`host_platform.cpp`, crash handling, config paths → MEMFS/IDBFS).
6. [ ] runtime: x86/SSE-specific code paths (FPU NI mode via MXCSR, `x86-64-v3`
       intrinsics) → portable scalar/wasm-simd128.
7. [ ] DVD over HTTP Range + IDBFS NAND.
8. [ ] Link translated shards (watch V8 per-function size/locals limits;
       split oversized functions if needed).
9. [ ] Frontend page: canvas, loading/progress, controls help, error overlay.
10. [ ] Performance pass (`-O3`, `-msimd128`, LTO decisions, code size).
