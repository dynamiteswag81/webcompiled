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
* **Performance pass (local, real game, Edge on an RTX 2060 SUPER):**
  * Staging uploads: browser WebGPU maps by shadowing the whole range in the wasm heap (37 MB
    zero-filled and copied back per frame, 15% of CPU in a race) and every frame waited for the
    map (spikes past 400 ms). The web build records into a persistent arena and `writeBuffer`s
    only the bytes used, then clears them (the renderer relies on zeroed staging memory: without
    the clear an earlier frame's Mii face was drawn over every race). Races: ~50 → ~60 FPS.
  * Menu freezes were first-use pipeline compilation on the browser GPU process's main thread
    (68 new pipelines → 2.1 s). GX pipelines now use `createRenderPipelineAsync` with
    skip-unready draws (worst hitch 0.27 s); things drawn into textures, such as kart previews,
    can be black for a moment the first time a screen appears.
  * Idle: `WebHost::SleepUntil` sleeps on timers armed from a macrotask hop (no nested-timer
    clamp) instead of hopping through the wait: ~35× fewer event-loop hops when idle.
* **Mobile (local): playable but buggy.** A full race on an Android phone (Chrome, LAN HTTPS)
  with the touch controls, in slow motion, before the performance pass. Phones now render a
  16:9 picture capped at 540 lines (`main.js` `setupRenderSize`, `?res=` / `?aspect=fill`);
  not yet re-measured on the phone. iPhone/iPad: no JSPI in WebKit yet.
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
* **Site tooling:** `web/serve.py` (Range/416/HEAD/MIME, precompressed `.br`/`.gz`
  siblings, immutable caching of hashed wasm, `--https` with a generated or supplied certificate),
  `web/selfsigned_cert.py` and `web/tools/precompress_dist.py` pass
  `python3 -m unittest discover -s web/tests -p 'test_*.py'` (55 tests);
  the page passes `node web/tests/frontend_test.mjs` (Playwright, headless
  Chromium: compat check, download progress with hashed/compressed wasm, start gate, help,
  error overlay and its retention of early errors, save-store banner, phone width);
  `node web/tests/https_browser_test.mjs` checks the HTTPS secure-context claim in Chromium.

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
  The mount first takes an exclusive Web Lock (`webcompiled-saves`, held for the life of the page,
  inside the same run dependency, so it cannot stall startup): a second tab of the same origin runs
  read-only (`Module.onMkwStorageReadOnly`, banner in `web/site/main.js`) and never writes to
  IndexedDB; without `navigator.locks` it behaves as before and warns in the console.
* Fatal reports reach the page (`mkw_host_report_fatal` → `Module.onMkwFatal`).

* Drop-in hosting: `web/host.sh` / `web/host.ps1` (game files dropped into
  `web/game/`: one disc image or an extracted DATA tree, optionally
  `RetroRewind6/`; fingerprint-cached build, then serve), `compose.yaml` +
  `web/docker/Dockerfile`. Verified with stub builds (bash and PowerShell 7)
  and a container built from prefetched tools.
* Retro Rewind: `translate-mod --skip-retro-wfc` leg and `RetroRewind` target
  in the build scripts; `dist/products.json` and a start-screen choice
  (`?product=`, `Module.mkwProduct`); the pack streams as a second WebDisc
  mount (`/mods/RetroRewind6`, `make_disc_manifest.py --tree`) and the real
  Riivolution code applies it (`web/tests/web_riivolution_test.cpp`, 41
  checks against a fake pack). Riivolution saves redirect into IDBFS.

### After the first real-game run (docs/web-test-report.md): changed, not yet verified with the game

Everything below is merged on `web-port` and tested without game data (tests named in each item).
None of it has run against the real disc yet. The local session should rebuild and go through
this list; the report's repro steps are repeated where they apply.

**Crashes**
* **C1 (viewport depth outside [0,1]).** Out-of-range GX depth ranges get a [0,1] viewport plus an
  exact fragment-shader depth remap (`ShaderConfig::depthRangeFixup`, aurora `gx.hpp`,
  `shader.cpp`, `common.cpp`); in-range draws are byte-identical to before. On the web, WebGPU
  validation errors are logged and counted instead of fatal (device loss stays fatal).
  Test: `web/tests/aurora_depth_range_test.mjs` (five GXPeekZ cases). *Verify:* sit on the title
  screen past the first "Scene Exit" (30–60 s): no `WebGPU error` lines, HUD and transitions look
  right.
* **C2 (hidden page).** The guest parks (JSPI) while the page is hidden, audio output pauses, and
  the VI grid and time base skip the hidden time. Several "no active frame" defects on the
  begin-failed path are fixed (`aurora_end_frame` without a frame, ImGui outside a frame, staging
  outside a frame, `get_last_draw_command` on an empty list). The exact out-of-bounds instruction
  from the report was never symbolized. Test: the smoke test hides the page mid-run (frames stop,
  "resumed after N ms", no trap). *Verify:* switch tabs or minimize for 60 s mid-race and during
  loading, then return; also two tabs. If any trap remains, symbolize it with
  `web/build/wasm/WiiCompiled.js.symbols`.
* **C3 (0×0 canvas).** `aurora_initialize` waits for a laid-out canvas; sizes are clamped and the
  scale NaN-guarded; no pass is built without its targets. Test: smoke test starts hidden.
  *Verify:* start the game while the tab is hidden, then show it; resize and fullscreen mid-game.
* **Browser shaders.** GX shaders no longer need the WGSL feature
  `uniform_buffer_standard_layout` (uniform `array<vec4<u32>, 3>` on the web), so Chromium 141
  compiles them; the documented Chrome/Edge 137+ minimum holds.

**Input** (`web/tests/input/run_input_test.sh`: native merge test, layout sync, 88 browser
checks with fake pads, real key events and the touch path)
* Default keyboard on player 1 with no setup, merged with a gamepad on the same port (buttons
  ORed, larger stick deflection, max trigger). Layout: arrows = stick, X = A, Z = B, Left Shift
  = R, Space = L, Enter = Start, C/V/Q = X/Y/Z, IJKL = C-stick, WASD = D-pad. Source of truth:
  `runtime/include/web_input_layout.h`.
* Gamepads through SDL3's Gamepad API backend: hot-plug, players 1–4, aurora's per-family
  layouts, analog triggers, rumble (renewed past the browser's 3 s cap). Fix for Chrome's
  "XInput" pads reporting the C-stick at full left until it moves.
* Controls panel generated from the real bindings, detected pads, and an input debug view
  (`?inputdebug=1`). F10 settings bar reachable with the mouse; bindings persist in IndexedDB.
* *Verify with real pads* (open the debug view with `?inputdebug=1`):
  1. Keyboard only: player 1 shows "keyboard"; arrows and X work in menus; in a race X
     accelerates, Z brakes, Shift drifts, Space uses the item, Enter pauses; check what C, V, Q
     and WASD do in game.
  2. Connect an Xbox pad and press a button: player 1 shows "keyboard + gamepad (merged)"; bottom
     face button accelerates, RT drifts, LT uses the item; the C-stick reads 0 at rest; the
     keyboard still works.
  3. DualShock/DualSense (Cross = A, R2 = R) and Switch Pro (bottom button = A, ZR = R): analog
     triggers show partial values in the debug view.
  4. Two to four pads land on players 2–4 and local multiplayer menus see them.
  5. Unplug pad 1 mid-race (player 1 keeps the keyboard, others keep their players); replug it.
  6. Rumble on item hits and when hit; a long rumble does not cut out after ~3 s; F10 ▸
     vibration off stops it.
  7. F10 (and the Settings button) with the mouse: rebind a key, reload, the binding stuck and
     is highlighted in the Controls panel; "Restore default keys"; controller presets; assigning
     a pad to a player. On Windows, F10 must not also focus the browser menu.
  8. A pad without the browser's standard mapping shows the warning in the Controls panel.

**Touch controls (phones and tablets)** (`web/site/touch.js`; `frontend_test.mjs` drives them
with real multi-touch in landscape and portrait; `input_test.mjs` checks them in the wasm)
* On-screen controller for player 1: a floating analog stick (lower left), A, B, Drift (R + full
  analog R), Item (L), Trick (D-pad up), Start, an "Auto A" toggle that keeps accelerating, and ☰
  for the page toolbar. Thumbs slide between buttons. The page writes the state into wasm memory
  (`Module.mkwInput.setTouch`); `WebInput::ApplyTouch` merges it into port 1 after the keyboard
  and gamepads (buttons ORed, larger deflection wins) on every PADRead, never while the F10 bar
  blocks input.
* Shown automatically once the screen is touched (hidden again on keyboard or gamepad use), or
  always / never; size, opacity, vibration and "fullscreen in landscape on start" in the Controls
  panel (saved per browser). Game rumble → `navigator.vibrate` when no gamepad is on player 1.
* *Verify on a real phone* (Chrome on Android with WebGPU; over `https://`, see "Let other
  people play"):
  1. The game starts fullscreen in landscape; the controls do not cover the HUD badly; the
     toolbar does not block them.
  2. Menus with the stick and A/B; a race with Auto A, steering, drifting (slide from A onto
     Drift), items, tricks off a ramp, pause.
  3. Performance with the overlay shown (it only changes on touches).
  4. Vibration on presses and on item hits.
  5. A tablet with a keyboard or gamepad: the controls get out of the way once they are used.

**Several players and hosting**
* One tab saves: an exclusive Web Lock on the save store; a second tab runs read-only with a
  banner (`web/tests/run_web_disc_test.sh`, Chromium tabs A–F).
* `serve.py --https` (self-signed certificate with LAN SANs, openssl or pure-Python) and `--lan`;
  `build.bat --lan` and `web/host.sh --https --lan` use them (`test_serve_https.py`,
  `https_browser_test.mjs`). *Verify:* a second device on Wi-Fi.
* Hashed, precompressed `.wasm` (`.gz`, `.br` when brotli is installed) with immutable caching
  (`precompress_dist.py`, `test_serve.py`). *Verify:* the real 122 MiB wasm: brotli time, size,
  second visit from cache.
* Error report keeps the first occurrence of each distinct error besides the last 200 lines;
  boot chatter is informational instead of `ERROR` (`RT_LOG_INFO`).

**Drop-in hosting**
* `build.bat` (Windows PowerShell 5.1, no admin): pinned and hash-checked portable toolchain in
  `tools\` (Python, CMake, Ninja, nodtool, .NET 8, emsdk 6.0.12 with pre-seeded packages), CA
  bundle for TLS, numbered steps, log in `web\build\build.log`, serves and opens the browser.
  Pins: `web/windows/toolchain.lock.json`. Tests: `web/windows/tests/run-tests.sh` (pwsh 7 in
  Docker, 63 checks, PS 5.1 lint). *Verify on Windows:*
  1. Double-click from Explorer, in a path with spaces, on stock Windows 10 and 11: the window
     stays open at the end and on errors; a SmartScreen prompt for the `.bat` is acceptable.
  2. `build.bat --tools-only` under real Windows PowerShell 5.1: lock JSON parsing, zip
     extraction, resumable downloads through redirects/proxies, logged child processes.
  3. The .NET SDK download matches its SHA-512 (unreachable from the sandbox);
     `tools\dotnet\dotnet --list-sdks` shows 8.0.425.
  4. emsdk installs and activates with the portable Python, reuses the pre-seeded packages, and
     `emcc --version` prints 6.0.12.
  5. **RVZ extraction with the bundled nodtool** (never exercised: the first test used an
     extracted tree), including on a PC without the VC++ runtime.
  6. The translator builds with the portable .NET; configure needs no downloads with the prebuilt
     package (and gets through FetchContent with the CA bundle if the package is stale); the
     first link downloads the emdawnwebgpu port.
  7. The 80-character path limit and 20 GB free-space checks are about right; nothing hits
     MAX_PATH.
  8. Steps 4–6 show sensible progress; a second double-click says "nothing to rebuild".
  9. The browser opens; a busy port moves to the next one; `build.bat --lan` serves HTTPS to a
     second device.
  10. One run with antivirus HTTPS scanning on, to see the TLS hint.
* Prebuilt libraries without game content in `web/prebuilt/web-prebuilt.tar.xz` (aurora, SDL3,
  abseil, zstd, libpng, freetype, imgui, sqlite, Crypto++; made by
  `web/tools/make_web_prebuilt.py`). A host compiles only the runtime and their own translated
  game; the package is used only when its source fingerprint matches the checkout, otherwise the
  build falls back to compiling everything (with a warning). Test: the smoke test links the real
  product against it (41 build steps instead of ~760). *Verify:* the "using the prebuilt web
  libraries" line in a real build, and the time saved. **Regenerate the package after any change
  under `aurora-main/` or to `runtime/CMakeLists.txt`**, or hosts silently lose the speed-up.

**Still open**
* The shipped Dockerfile's apt/emsdk/nodtool steps (the sandbox blocks the Debian mirrors).
* V8 limits on the largest translated functions, JSPI stack depth on deep guest call chains, and
  performance (28–60 FPS in the first test; needs a profiling pass once stable).
* Stray white/blue rectangles at the screen corners in the attract race (2D/HUD placement under
  the widescreen policy); not investigated without the game.

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

1. [x] `web/build.sh` / `web/build.ps1` (extract → translate → emcmake → dist),
       `web/host.sh` / `host.ps1`, Docker, Retro Rewind.
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
