# WebCompiled

Mario Kart Wii in the browser. WebCompiled is a WebAssembly + WebGPU port of
[WiiCompiled](https://github.com/patchzyy/Wiicompiled), the static recompilation of Mario Kart
Wii. It is built so that someone who owns the game can host it, and anyone with a recent Chrome
or Edge can open the URL and play: no install, no emulator, no per-player game files.

> [!WARNING]
> **In development.** Every part of the browser build is built and tested without game data, but
> the full pipeline has not yet been run end to end against a real disc. Expect rough edges. The
> current state is tracked in [docs/web-port.md](docs/web-port.md#status).

> [!IMPORTANT]
> There is no Nintendo code, no assets and no game data in this repository, and no pre-translated
> build is ever distributed. You need your own legally dumped, unmodified **PAL `RMCP01`** disc.
> The translation runs on the host's machine.

## How it works

WiiCompiled translates the game's PowerPC code into C++ ahead of time and compiles it into a
native program. WebCompiled compiles that same output, together with WiiCompiled's runtime and
the [aurora](https://github.com/encounter/aurora) graphics layer, to WebAssembly instead:

- **Graphics:** aurora's GX implementation on the browser's WebGPU.
- **Guest threads:** WebAssembly JSPI (JavaScript Promise Integration). No `SharedArrayBuffer`,
  so no special server headers are needed.
- **The disc:** served as plain static files and streamed on demand with HTTP Range requests.
  Players download what they use, not the whole multi-GB disc.
- **Saves:** stored in each player's browser (IndexedDB) and never uploaded.

The result is a folder of static files that any ordinary web server can host.

## Hosting it

Put your disc in `web/game/` and start it. The first start translates and compiles the game,
which takes a long time and several GB of RAM. After that it is cached and starts serving
immediately.

```sh
git clone https://github.com/dynamiteswag81/webcompiled.git
cd webcompiled
cp /path/to/your/mkwii.rvz web/game/       # .iso .wbfs .rvz .wia .gcz .ciso .gcm, or the extracted sys/ + files/
docker compose up                          # or, with the toolchain installed: web/host.sh
```

Then open <http://localhost:8080>.

To host on your own server, CDN or bucket, build once with `web/host.sh --build-only` and upload
`web/dist/`. The [hosting guide](docs/web-hosting.md) covers requirements (Range requests, HTTPS,
MIME types), server examples and troubleshooting.

### Retro Rewind

Put the [Retro Rewind](https://wiki.tockdom.com/wiki/Retro_Rewind) `RetroRewind6` folder next to
the disc in `web/game/`. It is built as a second game, and players choose between Mario Kart Wii
and Retro Rewind on the start screen. Online play (Retro-WFC) is not available in the browser.

## Playing

- **Browser:** Chrome or Edge 137 or newer, on desktop. The page checks for WebGPU and JSPI and
  tells you what is missing. Firefox and Safari will work once they ship both.
- **Controls:** keyboard or any gamepad the browser sees. Press `?` on the page for the controls
  overlay.
- **Saves** stay in your browser. Clearing the site's data deletes them.
- **No online play:** browsers have no raw network sockets.

## Repository layout

| Path | What it is |
| --- | --- |
| `web/` | Host scripts, build scripts, static server, the player page, browser tests |
| `runtime/` | WiiCompiled's runtime (HLE of the Wii OS, GX, audio, input, storage), with the web platform layer |
| `aurora-main/` | aurora, ported to Emscripten and browser WebGPU |
| `translator/` | WiiCompiled's static recompiler (.NET 8) |
| `projects/` | Translation project description for Mario Kart Wii |
| `docs/` | [Hosting guide](docs/web-hosting.md) and [web port design and status](docs/web-port.md) |
| `Launcher/` | WiiCompiled's native installers, kept from upstream |

## Building from source

`web/build.sh` (or `web/build.ps1`) is the full pipeline that `web/host.sh` drives: extract the
disc, verify it, run the translator, compile to WebAssembly with Emscripten, and assemble
`web/dist/`. It needs Emscripten 6.0.12, the .NET 8 SDK, CMake 3.25+, Ninja, Python 3 and
nodtool or DolphinTool. The Docker image bundles all of them.

Most of the work needs no game data. The translator test suite, the aurora example in the browser,
the runtime compile audit and the web tests all run without it; [docs/web-port.md](docs/web-port.md)
lists the commands.

## Credits

WebCompiled exists because of **[WiiCompiled](https://github.com/patchzyy/Wiicompiled)** by patchzyy
and its contributors. The translator, the runtime and the Mario Kart Wii work are theirs; this
project ports them to the browser. Please support and star the original, and check
[their README](https://github.com/patchzyy/Wiicompiled#readme) for the native version.

Also standing on the shoulders of:

- **[aurora](https://github.com/encounter/aurora)**: the GameCube/Wii GX compatibility layer the
  graphics run on (MIT).
- **[Dawn](https://dawn.googlesource.com/dawn)** and Emscripten's **emdawnwebgpu**: WebGPU in C++
  and in the browser.
- **[Emscripten](https://emscripten.org)**: the WebAssembly toolchain.
- **[Dolphin Emulator](https://github.com/dolphin-emu/dolphin)**: the hardware reference
  WiiCompiled relies on, and the source of the free DSP coefficient ROM and the default
  WiiConnect24 bootstrap tree bundled with the runtime.
- **[nod](https://github.com/encounter/nod)**: disc image extraction.
- **[Retro Rewind](https://wiki.tockdom.com/wiki/Retro_Rewind)** by ZPL and team.
- **[Wheel Wizard](https://github.com/TeamWheelWizard/WheelWizard)** and everyone in the static
  recompilation community.

Bundled third-party components and their licenses are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

WebCompiled is independent: it is not affiliated with WiiCompiled, Retro Rewind or Wheel Wizard,
so please don't report browser-build problems to them.

## License

WebCompiled is free software under the [GNU General Public License, version 3](LICENSE), the same
license as WiiCompiled, from which it is derived. It comes WITHOUT ANY WARRANTY; see the license
for details.

Not affiliated with, endorsed by, or associated with Nintendo. Mario Kart Wii is a trademark of
Nintendo. No Nintendo intellectual property is contained in, distributed with, or obtainable
through this project. Don't host it publicly for people who don't own the game.
