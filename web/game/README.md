# Game files go here

Drop your own game files into this folder, then double-click `build.bat` in the main folder
(Windows), or run `web/host.sh` or `docker compose up` (Linux, macOS).
Nothing in this folder is ever committed or uploaded; only this README is tracked.

## What to drop

1. **Mario Kart Wii (PAL, RMCP01)** - exactly one of:
   - a disc image: `.iso` `.gcm` `.gcz` `.ciso` `.wbfs` `.wia` or `.rvz`, **or**
   - an already extracted DATA partition: a folder containing `sys/main.dol` and `files/`
     (it can sit one level down, e.g. `game/DATA/sys/main.dol`).

   It must be an unmodified PAL copy; the build checks `main.dol` and `StaticR.rel` hashes and
   stops with a clear message if they do not match.

2. **Retro Rewind** (optional) - the `RetroRewind6` folder, i.e. the one that contains
   `Binaries/Code.pul` (or the folder that contains `RetroRewind6`). When it is present the site
   offers both "Mario Kart Wii" and "Retro Rewind" on its start screen.

## Example

    web/game/
      mkwii-pal.rvz
      RetroRewind6/
        Binaries/Code.pul
        ...

## What happens next

The first run translates and compiles the game for the browser (long, needs several GB of RAM)
and writes the finished site to `web/dist/`. The result is cached: later runs only serve it,
until the game files or this repository change. See `web/host.sh --help`.
