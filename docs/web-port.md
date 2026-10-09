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
