# WebCompiled

Mario Kart Wii in the browser. WebCompiled is a WebAssembly + WebGPU port of
[WiiCompiled](https://github.com/patchzyy/Wiicompiled), the static recompilation of Mario Kart
Wii. It is built so that someone who owns the game can host it, and anyone with a recent Chrome
or Edge can open the URL and play: no install, no emulator, no per-player game files.

> [!WARNING]
> **In development, but playable.** Built from a real PAL disc on Windows with `build.bat`, both
> Mario Kart Wii and Retro Rewind run in Chrome/Edge (about 60 FPS in races on a desktop PC).
> **Mobile is playable but buggy:** a full race works on an Android phone with the on-screen
> controls, but slowly, with glitches. Expect rough edges everywhere; online play is not
> available. The current state is tracked in [docs/web-port.md](docs/web-port.md#status).

> [!IMPORTANT]
> There is no Nintendo code, no assets and no game data in this repository, and no pre-translated
> build is ever distributed. You need your own copy of the game: unmodified, **PAL `RMCP01`**.
> The translation runs on the host's machine.

## Host it yourself (Windows)

No programming tools needed. You need Windows 10 or 11 (64-bit), about 20 GB of free disk space,
8 GB of RAM or more, an internet connection for the first run, and Chrome or Edge.

1. **Download WebCompiled.** On the GitHub page, click the green **Code** button, then
   **Download ZIP**. Unzip it to a short folder path, for example `C:\WebCompiled`.
2. **Add your game.** Put your own Mario Kart Wii disc file (`.rvz`, `.iso`, `.wbfs`, `.wia`,
   `.gcz`, `.ciso` or `.gcm`) into the `web\game` folder. Only one disc file.
   *Optional:* also put the [Retro Rewind](#retro-rewind) `RetroRewind6` folder in `web\game`
   to get Retro Rewind as a second game.
3. **Double-click `build.bat`.** A window opens and shows numbered steps. The first time it
   downloads its tools (about 1.2 GB) and builds the game for the browser, which takes about
   30 minutes. Running it again only rebuilds what changed. It only builds; it does not start
   anything.
4. **Double-click `start-server.bat` to play.** It opens a window that runs the game server and
   opens your browser at <http://localhost:8080>. Pick the game on the start screen. **Close that
   window to stop the server.** Start it again whenever you want to play; no rebuild needed.

If the build goes wrong, its window stays open and says what happened, what usually fixes it,
and where the full log is (`web\build\build.log`).

## Let other people play

Browsers only allow the graphics API the game uses (WebGPU) on secure pages: `https://` or the
same computer's `localhost`. So other devices need HTTPS.

* **On your own network:** start the server with `start-server.bat --lan` (or
  `web/host.sh --https --lan` on Linux and macOS). It makes a self-signed certificate; other
  devices open `https://<this PC's IP address>:8080`.
  Other devices see a certificate warning the first time; they can continue past it once.
  To run it, open a terminal in the WebCompiled folder (in File Explorer, type `cmd` in the
  address bar and press Enter) and type `start-server.bat --lan`. In PowerShell, type
  `.\start-server.bat --lan` instead. Or make a shortcut to `start-server.bat` and add ` --lan` at
  the end of its Target. If Windows Firewall asks, allow it on private networks.
* **Over the internet:** put a server with a real certificate in front of it, such as Caddy, a
  Cloudflare Tunnel or Tailscale. The [hosting guide](docs/web-hosting.md#let-other-people-play)
  has short recipes for each.

Every player keeps their own saves in their own browser. One browser tab at a time per player
saves progress; a second tab says so and runs without saving.

## Linux and macOS

Docker is the easiest way:

```sh
git clone https://github.com/dynamiteswag81/webcompiled.git
cd webcompiled
cp /path/to/your/mkwii.rvz web/game/
docker compose up
```

Without Docker, install Emscripten 6.0.12, the .NET 8 SDK, CMake 3.25+, Ninja, Python 3 and
[nodtool](https://github.com/encounter/nod/releases), then run `web/host.sh`. It checks for each
of them and says what's missing. `web/host.sh --help` lists the options (`--https --lan`,
`--build-only`, `--rebuild`, ...).

### Hosting the files on another server

`build.bat` (or `web/host.sh --build-only`) leaves a folder of static files in
`web/dist/` that any web server with HTTP Range support can host. See the
[hosting guide](docs/web-hosting.md) for server settings, caching and compression.

### Retro Rewind

Put the [Retro Rewind](https://wiki.tockdom.com/wiki/Retro_Rewind) `RetroRewind6` folder (the
one containing `Binaries\Code.pul` and `xml\RetroRewind6.xml`) next to the disc in `web/game/`.
It is built as a second game, and players choose between Mario Kart Wii and Retro Rewind on the
start screen. If you already play Retro Rewind through Wheel Wizard and Dolphin, a complete copy
is usually in `%APPDATA%\Dolphin Emulator\Load\Riivolution\WheelWizard\RetroRewind6`; copy that
folder. Online play (Retro-WFC) is not available in the browser.

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

The libraries that contain no game code (aurora, SDL3, abseil, zstd, Crypto++, ...) ship
precompiled in `web/prebuilt/`, so a host only compiles the runtime and their own translated game.

## Playing

- **Browser:** Chrome or Edge 137 or newer, on desktop, or Chrome on Android phones and tablets
  that have WebGPU. The page checks for WebGPU and JSPI and tells you what is missing. Firefox and
  Safari (so every iPhone and iPad browser) will work once they ship both.
- **Phones (playable, but buggy):** a race runs, slowly. Phones render a 16:9 picture at up to
  540 lines, letterboxed (top-aligned in portrait, leaving room for the touch controls). Add
  `?res=720` to the address for a sharper picture, `?res=0` for full resolution, or
  `?aspect=fill` to use the whole screen. The first time a menu screen appears, some things
  (such as the kart previews) can stay black for a moment while their shaders compile.
- **Controls:** the keyboard works right away, and any gamepad the browser sees (Xbox,
  PlayStation, Switch Pro, ...) joins automatically: the first pad plays alongside the keyboard
  as player 1, more pads become players 2–4. Press a button on a pad once so the browser
  shows it to the page. Default keys:

  | Key | Does |
  | --- | --- |
  | Arrow keys | Steer / move in menus |
  | X | Accelerate / confirm (A) |
  | Z | Brake, reverse / back (B) |
  | Left Shift | Drift / hop (R) |
  | Space | Use item (L) |
  | Enter | Pause (Start) |
  | W A S D | D-pad (tricks, wheelies) |
  | C / V / Q, I J K L | X / Y / Z, C-stick |

  Press `?` on the page for the controls panel (it lists connected pads), and F10 in the game to
  rebind keys or controllers.
- **Touch screens:** on a phone or tablet, on-screen controls appear as soon as you touch the
  screen: drag in the lower left to steer, and use A, B, Drift, Item and Trick on the right.
  **Auto A** at the top keeps accelerating for you. Size, opacity and vibration are in the
  controls panel (☰, then Controls). Other devices need the `https://` address from "Let other
  people play".
- **Saves** stay in your browser. Clearing the site's data deletes them.
- **No online play:** browsers have no raw network sockets.

## Repository layout

| Path | What it is |
| --- | --- |
| `build.bat` | One-click Windows build (see "Host it yourself") |
| `start-server.bat` | Starts the game server; closing its window stops it |
| `web/` | Host scripts, build scripts, static server, the player page, browser tests |
| `web/game/` | Where the host puts their own disc file (never committed) |
| `web/prebuilt/` | Precompiled libraries without game content, for faster builds |
| `runtime/` | WiiCompiled's runtime (HLE of the Wii OS, GX, audio, input, storage), with the web platform layer |
| `aurora-main/` | aurora, ported to Emscripten and browser WebGPU |
| `translator/` | WiiCompiled's static recompiler (.NET 8) |
| `projects/` | Translation project description for Mario Kart Wii |
| `docs/` | [Hosting guide](docs/web-hosting.md) and [web port design and status](docs/web-port.md) |
| `Launcher/` | WiiCompiled's native installers, kept from upstream |

## Building from source

`web/build.sh` (or `web/build.ps1`) is the full pipeline that `web/host.sh` and `build.bat` drive:
extract the disc, verify it, run the translator, compile to WebAssembly with Emscripten, and
assemble `web/dist/`. `build.bat` downloads a pinned, hash-checked toolchain into `tools\`; the
Docker image bundles the same tools. `web/tools/make_web_prebuilt.py` regenerates the prebuilt
library package.

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
