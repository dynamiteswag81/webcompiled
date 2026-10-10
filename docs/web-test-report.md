# Web build: first real-game test report (2026-10-09)

Local session, real PAL `RMCP01` disc, branch `web-port` at `bb2a001` plus the fixes in the
"Fixed during this test" section. This is the first time the full pipeline ran against the real
game. Everything below was observed on the operator's machine; nothing here contains game data.

**Machine:** Windows 11, Ryzen 7 3800X (16 threads), 32 GB RAM, RTX 2060 SUPER.
**Browsers:** Edge 154 (window and headless), Claude desktop's Chromium 152. Both have WebGPU and
JSPI.

## Summary

* **It boots and plays its attract demo in the browser.** The OS boots, the disc streams, the
  title screen ("Press the A Button") renders through WebGPU at 60 FPS, and the attract-mode race
  (Luigi Circuit, CPU karts) renders in 3D.
* **It is not playable yet.** It crashes within about 1–2 minutes (three distinct crashes, below),
  keyboard input does nothing, and controllers were not tested.
* **Hosting is not yet "drop a file in a folder".** See "Operator experience".

## Fixed during this test (already pushed to `web-port`)

1. **Link failure:** `wasm-ld: initial memory too small, 24460096 bytes needed`. Static data is
   about 24 MB, above Emscripten's 16 MB default. Added `-sINITIAL_MEMORY=256MB`
   (`runtime/cmake/PublicProducts.cmake`).
2. **Boot fatal "NAND initialization failed / Cannot persist NAND setting.txt":**
   `include/nand_settings.h` publishes with `::link()`, but MEMFS/IDBFS have no hard links. On
   `__EMSCRIPTEN__` it now uses `rename()` (one game per page, destination checked absent).
   `RenameNoReplace` in `hle/storage/nand_api.cpp` returned `operation_not_supported` on
   Emscripten; it now uses exists-check + rename, as does the cross-mount `create_hard_link`.
3. **Debuggability:** the product link now passes `--emit-symbol-map`, so
   `web/build/wasm/WiiCompiled.js.symbols` maps `wasm-function[N]` in a player's error report to
   a name. The map matches only the exact binary it was linked with (verified: an otherwise
   identical relink moved most functions).

## Crashes (highest priority)

### C1. Any WebGPU validation error aborts the game; the first one is an out-of-range viewport depth

Reproduces every run: start the game, leave it idle on the title screen, and it aborts at the first
scene change ("1 Scene Exit"), about 20–40 s in.

```
[aurora::gpu] WebGPU error 2: Viewport minDepth (0.950000) and maxDepth (1.060000) are not in [0, 1]
 - While encoding [RenderPassEncoder "Render pass"].SetViewport(0, 0, 1003.2, 456, 0.95, 1.06).
[runtime] fatal dialog: The game stopped because Aurora reported a fatal renderer error.
RuntimeError: unreachable
```

Symbolized stack: `emwgpuOnUncapturedError` → `aurora::webgpu::initialize(...)::$_1` (the
uncaptured-error callback) → `abort`.

* The game sets GX viewports whose depth range extends past 1.0, which browser WebGPU rejects.
  Fix the way Dolphin does: clamp the viewport's min/max depth to [0, 1] and fold the remainder
  of the GX depth range into the vertex shader's z transform, so the same depths come out.
* On the web, a validation error should be logged (rate-limited) and counted, not fatal. One bad
  draw must not end the session.

### C2. A hidden page (background tab, minimized or fully covered window) stalls rendering, then crashes

* When `document.visibilityState` is `hidden`, SDL marks the window hidden. Aurora's
  `window::is_paused()` then makes `begin_frame` return false.
  `BeginNextAuroraFrameWithRetry` (`hle/gx/gx_frame.cpp`) spins about 100 ms per frame and gives up
  ("BeginAuroraFrame retry EXPIRED … frame remains inactive"), dropping every draw while game
  logic keeps running.
* After about 10 s of that it traps: `RuntimeError: memory access out of bounds`. The last lines
  are `Dropping command SetViewport` ×3 and
  `Dropping resolve pass without an active render pass`.
* Unsymbolized stack (older binary): `wasm-function[11663]` ← `[9960]` ← `[16179]` ←
  `[33959]` ← `[9745]` ← `[15021]` ← `[16470]` ← `[336]` (`InvokeIndirectCpu` in that build) ←
  `[16108]`. The same stack appeared in two separate runs, so it is deterministic.
* Players hit this just by switching tabs. Fix: on the web, pause the guest while the page is
  hidden. Suspend in VI pacing (`WebHost`) until `visibilitychange` reports visible, and pause
  audio too. That also stops a background tab from burning CPU. Separately, find the
  out-of-bounds access: it is a code path that assumes an active frame or render pass.

### C3. Starting while the canvas is 0×0 crashes in `beginRenderPass`

If the page is hidden or zero-sized when `aurora_initialize` runs, the log shows
`window=0x0 native=0x0` and `Using framebuffer size 640x528 scale -nan`. No depth texture gets
created, and the first frame throws:
`TypeError: Failed to execute 'beginRenderPass' … 'depthStencilAttachment' … 'view' … Required
member is undefined`. Fix: wait for a non-zero canvas before initializing (or clamp every size to
≥ 1 and recreate on resize), and never build a pass without a depth view.

## Input

### I1. Keyboard does nothing (user-reported, confirmed)

`aurora-main/lib/dolphin/pad/pad.cpp`: `g_defaultKeys` / `g_defaultKeyAxis` are all
`PAD_KEY_INVALID` and `m_mappingsSet` is false. Keyboard input only exists after the F10 overlay
enables "Keyboard and mouse" for a port, and that also disables the gamepad on that port
(`if (controller && !m_mappingsSet)`).

Required for the web:
* A **default keyboard layout active on port 1 with no setup**, merged with any gamepad on the same
  port (OR the buttons, take the larger stick deflection), so plugging in a pad doesn't need a
  setting change. Suggested layout for Mario Kart (GC pad semantics):
  arrows = stick (steer / menu), X = A (accelerate / OK), Z = B (brake / back),
  Shift = R (drift / hop), Space = L (item), Enter = Start (pause), C = X, V = Y,
  Q = Z, IJKL = C-stick. Keep F10 for rebinding, and persist bindings in IndexedDB.
* Fix the page's Controls panel (`web/site`): it says "Placeholder" and lists keys the game
  doesn't use. Generate it from the real defaults.
* Check that F10 (settings bar) opens and is usable with the mouse in the browser (untested).

### I2. Controller support (user requirement)

The operator wants controllers to work out of the box:
* Browser Gamepad API through SDL3's Emscripten joystick backend, standard mapping (Xbox,
  PlayStation, Switch Pro, generic XInput). Pads connected **after** page load must be picked up
  (browsers only expose a pad after a button press on the page), with hot-plug/unplug.
* First pad → port 1 (alongside the keyboard), further pads → ports 2–4 for local split-screen.
* Sensible GameCube-layout defaults for each pad family (aurora already has presets, e.g. the
  Classic/PlayStation presets in `settings_overlay.cpp`), analog triggers where available, and
  rumble through `Gamepad.vibrationActuator`.
* The Controls panel lists the detected pads, their port, and their button layout.
* Not testable without hardware in the cloud. Make it testable: e.g. a page debug view of raw
  `navigator.getGamepads()` vs what the game receives. The local session will test with real pads.

## More than one client

Measured:
* **Server:** `web/serve.py` (ThreadingHTTPServer, keep-alive) served two clients at once without
  trouble: both downloaded the 122 MiB wasm and streamed the disc.
* **Two tabs in one browser both run the game** (about 28 FPS each in the attract race, sharing
  the CPU), but:
  * the non-focused tab is `hidden` → crash C2;
  * **both tabs share one IndexedDB save store with no coordination** (IDBFS autoPersist, no Web
    Locks or BroadcastChannel). Saves and settings from one tab can silently overwrite the other's.
    Fix: take a Web Lock (`navigator.locks`) for the save store. A second tab runs read-only (or
    refuses to start) and says so clearly.
* **Other devices cannot use it as shipped**, which is probably what "it can't handle more than one
  client" was:
  * `serve.py` binds `127.0.0.1` by default, and the "Serve:" line `build.sh` prints uses that
    default. Other machines can't connect.
  * More importantly, **WebGPU only exists in secure contexts**. `http://192.168.x.x:8080` from a
    phone or another PC is not secure, so the page reports WebGPU missing even after the bind is
    fixed. LAN/Internet hosting needs HTTPS. Give the host an easy path: a `--https` mode for
    `serve.py` with a generated self-signed certificate (documenting the browser warning), and
    documented recipes for Caddy (automatic HTTPS) and a tunnel (e.g. Cloudflare Tunnel or
    Tailscale Serve).
  * Hosting for many players: precompress `WiiCompiled.wasm` (brotli/gzip, about 122 MiB raw)
    and serve the compressed file with `Content-Encoding`. Every client downloads it on every
    visit unless it is cached (`serve.py` sends `Cache-Control: no-cache` for wasm; use a
    content-hashed filename plus long-lived caching instead).

Follow-up (implemented, tested without game data; see [web-hosting.md](web-hosting.md)): the save store
takes a Web Lock and a second tab runs read-only with a banner; `serve.py --https --lan` with a
generated self-signed certificate; the wasm is content-hashed, precompressed (`.gz`, `.br` when
available), served with `Content-Encoding` and `immutable` caching; the error report keeps the first
occurrence of each distinct error. Not yet exercised: a real second device over Wi-Fi, a real Caddy,
nginx, tunnel or Tailscale setup, and the real 122 MiB wasm.

## Operator experience: is drop-in hosting easy for a human? Not yet

The user's goal: **a host drops a game file into a folder and runs one thing.** Here is what it
actually took on stock Windows 11 (by an agent, not a typical user):

1. `web/host.ps1` / `web/build.ps1` require **PowerShell 7 (`pwsh`)**, which Windows doesn't ship
   (it has 5.1), so the documented Windows entry point did not run. I used `web/build.sh` through
   **Git Bash**, also not on a stock PC.
2. **Prerequisites by hand:** emsdk (git clone + about 1 GB download, `emsdk install/activate`) and
   the .NET 8 SDK (`dotnet-install.ps1` into a local folder). CMake, Ninja and Python happened to
   be installed already. A typical user would have none of them.
3. **Configure failed downloading dependencies:** CMake (WinLibs build) could not verify
   GitHub's TLS certificate ("certificate signer not trusted") for abseil's FetchContent. It only
   worked after setting `SSL_CERT_FILE` to Git for Windows' `ca-bundle.crt`
   (`CMAKE_TLS_CAINFO` alone was not enough). A typical user would be stuck here.
4. The link failed (initial memory) and the game died at boot (NAND hard link). Both are fixed
   above.
5. **Disc extraction was not exercised:** I passed an already-extracted tree. The disc-image path
   (the one the user wants: drop the `.rvz` in) needs nodtool or DolphinTool, which aren't
   installed by default either, so `build.bat` must bundle nodtool.
6. **Time and resources:** translation about 30 s; the first full compile about 20 min
   (833 Ninja steps at `-j16`); link + `wasm-opt` about 4.5 min with about 3 GB RAM for
   `wasm-opt`. Any link-flag change reconfigures and recompiles everything.

**Verdict:** a developer can do it with about an hour of troubleshooting. A non-developer cannot
today. The ideal flow below is the target.

### Required: one double-click batch file plus README steps

* Add **`build.bat`** at the repo root (and a `host.bat` / "Start server" step it ends with). It
  must work on a **stock Windows 10/11 PC with nothing installed**, no admin rights, from a
  plain double-click:
  1. Find exactly one disc image (`.iso .rvz .wbfs .gcz .ciso .wia .gcm`) or an extracted `DATA`
     tree in `web\game\`. If there is none or more than one, say exactly what to do and pause.
  2. **Bootstrap a pinned, portable toolchain into `tools\`** (download with progress, verify
     SHA-256, resume or skip when already present): emsdk at the pinned version, the .NET 8 SDK via
     `dotnet-install.ps1`, portable CMake and Ninja, a Python (emsdk's bundled one is fine), and
     nodtool. Use only `cmd` and Windows PowerShell **5.1** (no `pwsh`, no Git Bash).
  3. Set the TLS CA bundle for CMake/FetchContent itself (step 3 above), or vendor/prefetch the
     FetchContent sources so the build needs no extra TLS setup.
  4. Run the build with numbered, human-readable step messages ("Step 4/7: compiling the game,
     about 20 minutes…") and an end summary. Keep the window open on error, with the log path and
     the likely fix.
  5. Finish by starting the server and printing **the URL to open** (and opening it in the
     default browser).
* **The disc image is the input.** Dropping the operator's own `.rvz` (or `.iso`, `.wbfs`, ...)
  into `web\game\` must be enough: `build.bat` extracts it with its own bundled, pinned nodtool
  (no DolphinTool or other emulator required). Don't add a "point at an existing WiiCompiled
  install" mode; the user decided against it. The image path (RVZ in particular) was **not**
  exercised in this test, because an already-extracted tree was used, so it needs real
  verification.
* **Cut the host's compile time** by shipping the non-game web libraries prebuilt (SDL3, aurora,
  abseil, zstd, Crypto++, pugixml, … contain no Nintendo code), the way native WiiCompiled ships
  a "native prebuilt" package. Then only the translated shards and the runtime compile locally.
  (A pre-translated or prebuilt game binary must still never be distributed.)
* **README:** a short "Host it yourself (Windows)" section at the top, written for
  non-developers:
  1. download the repo (green Code → Download ZIP), unzip;
  2. put your own disc file in `web\game\`;
  3. double-click `build.bat`; the first run takes about 30 minutes, later runs start in seconds;
  4. open the URL it prints in Chrome or Edge.

  Then sections for "Let other people play" (HTTPS, see above) and Linux/macOS (`build.sh`,
  Docker). Keep the existing rule: never say where or how to obtain game files.

## Other observations

* Performance: title screen 60 FPS. Title→demo transition about 42 FPS. Attract race about 28 FPS
  per instance with two instances running (single-instance race FPS not measured before C1/C2 hit).
  Needs a profiling pass once it's stable.
* Rendering: in the attract race there are stray white and blue rectangles at the screen corners
  (likely HUD/2D elements mis-placed under the widescreen "stretch" policy); otherwise the 3D scene
  looks right. The in-game FPS counter (top right) sits under the page's Fullscreen button.
* Audio: the operator reports it sounds fine. The log shows
  `[audio] output queue full … dropping blocks` around boot; check that it only happens while
  hidden or loading.
* Boot log noise worth silencing: hundreds of `[error]`-level lines that are informational
  (`… (stubbed)`, `NANDOpen: FAILED to open` for optional files on a fresh NAND). The page's error
  report keeps only the last 200 lines, so this noise pushes out the lines that matter. Lower
  their level, and keep the first failure of each kind in the report.
* Aurora system info prints `Memory: 0 MiB`, `CPU: Unknown`, `Device: (Unknown)` on the web.
  Cosmetic.

## How the local session tested (so fixes can be re-verified on recall)

* Build: `web/build.sh <extracted DATA dir> --skip-translate` from Git Bash with emsdk, .NET and
  `SSL_CERT_FILE` set; incremental relinks via `ninja -C web/build/wasm WiiCompiled`.
* Real-window and headless Edge driven over the DevTools protocol (separate throwaway profiles):
  click Start, stream the console, screenshot, inject key events, open two tabs.
* Repro for C1: start, wait about 30 s on the title screen. For C2: start, then cover or hide the
  window for about 60 s. For C3: start the game while the tab is hidden.
