# Hosting WebCompiled

> [!IMPORTANT]
> Status: the web build is **in development**. Every piece below is built and
> tested without game data, but the full pipeline has not yet been run against a
> real disc. See [web-port.md](web-port.md#status) for what is verified.

This guide is for the person running the server. Players need nothing but a
supported browser: they open your URL and play.

The repository never contains Nintendo code, assets or game data, and no
pre-translated build is distributed. You provide your own clean PAL
`RMCP01` disc. Your machine translates and compiles it once, and the result
is a folder of static files you can host anywhere.

## Quick start

### With Docker (nothing else to install)

```sh
git clone https://github.com/dynamiteswag81/webcompiled.git
cd webcompiled
cp /path/to/your/mkwii.rvz web/game/          # or .iso .wbfs .gcz .ciso .wia .gcm
# Optional: Retro Rewind
cp -r /path/to/RetroRewind6 web/game/
docker compose up
```

Open <http://localhost:8080>. The first start translates and compiles the game,
which takes a long time (tens of minutes, several GB of RAM). Later starts reuse
the cached build and begin serving immediately.

### Without Docker

Install Emscripten 6.0.12 (emsdk), the .NET 8 SDK, CMake 3.25+, Ninja,
Python 3 and [nodtool](https://github.com/encounter/nod/releases) (or
DolphinTool), then:

```sh
cp /path/to/your/mkwii.rvz web/game/
web/host.sh            # Windows: pwsh web/host.ps1
```

`web/host.sh` checks what is missing and says how to get it. It builds only
when the inputs changed and then serves on port 8080. Useful flags:

| Flag | Meaning |
| --- | --- |
| `--port N`, `--bind ADDR` | Where to serve (default `0.0.0.0:8080`) |
| `--build-only` | Build `web/dist/` and exit, for hosting with another server |
| `--serve-only` | Serve an existing `web/dist/` |
| `--rebuild` | Ignore the cache and build again |
| `--game DIR` | Use another drop folder instead of `web/game/` |

## What goes in `web/game/`

You can provide either of these:

* **One disc image** of Mario Kart Wii PAL (`RMCP01`), unmodified: `.iso`,
  `.gcm`, `.gcz`, `.ciso`, `.wbfs`, `.wia` or `.rvz`.
* **An extracted disc**, meaning the DATA partition's `sys/` and `files/`
  folders, for example from Dolphin's "Extract Entire Disc". It may sit directly
  in `web/game/` or one folder down, such as `web/game/DATA/`.

Optionally, add the **Retro Rewind** pack: the `RetroRewind6/` folder (the one
holding `Binaries/Code.pul`), or its parent folder. When it is present, a
second product is built and players choose between Mario Kart Wii and Retro
Rewind on the start screen.

Only the clean PAL executable is accepted; `main.dol` and `StaticR.rel` are
checked against known hashes before anything is translated.

## Hosting `web/dist/` elsewhere

`web/host.sh --build-only` (or `web/build.sh <image>`) writes a
self-contained static site:

```
web/dist/
  index.html, main.js, style.css       the page
  WiiCompiled.js, WiiCompiled.wasm     the game
  RetroRewind.js, RetroRewind.wasm     (with Retro Rewind)
  products.json                        which games the start screen offers
  disc/                                the extracted disc (sys/, files/)
  disc-manifest.json                   file list and sizes for disc/
  mods/RetroRewind6/                   (with Retro Rewind)
  mods/RetroRewind6-manifest.json
```

Upload the whole folder to any static web server. Requirements:

* **HTTP Range requests** for `disc/` and `mods/`. The game streams the disc on
  demand (a few MB for the menus, not the whole multi-GB tree), so a server
  that ignores `Range` still works but downloads whole files. nginx, Caddy,
  Apache, S3/R2/GCS buckets and most CDNs support Range by default.
* **`.wasm` served as `application/wasm`.** It works without this, but more
  slowly.
* **HTTPS**, or `localhost`. Browsers only expose WebGPU to secure contexts.
* No special headers: no COOP/COEP and no `SharedArrayBuffer` are needed.
* Do not compress `disc/` or `mods/` on the fly. Some servers drop `Range`
  support for compressed responses. Compressing the `.wasm` and `.js` is fine.

Example nginx location:

```nginx
location / {
    root /srv/wiicompiled/dist;
    types { application/wasm wasm; }
}
location ~ ^/(disc|mods)/ {
    root /srv/wiicompiled/dist;
    gzip off;
}
```

## For players

* **Browser:** Chrome or Edge 137 or newer, on desktop. The page checks for
  WebGPU and WebAssembly JSPI and says what is missing. Firefox and Safari will
  work once they ship both.
* **Controls:** keyboard, or any gamepad the browser's Gamepad API sees. Press
  `?` or `H` on the page for the controls overlay.
* **Saves:** stored per browser in IndexedDB on the player's own machine.
  Clearing site data deletes them, and nothing is uploaded to the server.
* **Online play:** not available in the browser. The web build has no network
  stack.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Your browser is missing WebGPU / JSPI" | Older browser, Firefox/Safari, or the page is not on HTTPS/localhost |
| Error overlay mentions `disc-manifest.json` | `disc/` or the manifest was not uploaded next to `index.html` |
| Very slow start, huge transfer | The server ignores `Range` (look for whole-file 200 responses to `disc/` requests) |
| Build stops at the hash check | The disc is not a clean PAL `RMCP01` dump |
| Build killed / out of memory | Translation and compilation need several GB of RAM; lower `--jobs` |

The error overlay has a **Copy details** button. Include its output when you
report a problem.
