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
| `--https` | Serve HTTPS with a self-signed certificate; needed for other devices (see [Let other people play](#let-other-people-play)) |
| `--cert FILE --key FILE` | Serve HTTPS with your own certificate instead |
| `--san NAME` | Extra host name or IP for the generated certificate (repeatable) |
| `--lan` | Listen on all interfaces (already the default of `host.sh`; same as `--bind 0.0.0.0`) |
| `--build-only` | Build `web/dist/` and exit, for hosting with another server |
| `--serve-only` | Serve an existing `web/dist/` |
| `--rebuild` | Ignore the cache and build again |
| `--game DIR` | Use another drop folder instead of `web/game/` |

On Windows the same options exist as `-Https`, `-Cert`, `-Key`, `-San`, `-Lan`, `-Port`, and so on
(the `--https` spelling works too).

## What goes in `web/game/`

You can provide either of these:

* **One disc image** of Mario Kart Wii PAL (`RMCP01`), unmodified: `.iso`,
  `.gcm`, `.gcz`, `.ciso`, `.wbfs`, `.wia` or `.rvz`.
* **An extracted disc**, meaning the DATA partition's `sys/` and `files/`
  folders. It may sit directly in `web/game/` or one folder down, such as
  `web/game/DATA/`.

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
  WiiCompiled.js                       the game's loader (not hashed, always revalidated)
  WiiCompiled.1a2b3c4d.wasm            the game, named after its content hash (about 120 MiB)
  WiiCompiled.1a2b3c4d.wasm.gz         the same, precompressed (and .br when brotli was available)
  RetroRewind.js, RetroRewind.<hash>.wasm[.gz|.br]   (with Retro Rewind)
  products.json                        which games the start screen offers, and the wasm file names/sizes
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
* **HTTPS**, or `localhost`. Browsers only expose WebGPU to secure contexts
  (see [Let other people play](#let-other-people-play)).
* No special headers: no COOP/COEP and no `SharedArrayBuffer` are needed.
* Do not compress `disc/` or `mods/` on the fly. Some servers drop `Range`
  support for compressed responses. Compressing the `.wasm` and `.js` is fine
  (and the precompressed files make it free, see the next section).

## Caching and compression

The wasm file is the one big download that every player makes (about 120 MiB
raw). `web/build.sh` and `web/build.ps1` therefore finish the site with
`web/tools/precompress_dist.py`, which:

* renames each `X.wasm` to `X.<sha8>.wasm`, where `<sha8>` is the first 8 hex digits of its SHA-256.
  The name changes whenever the content does, so servers can send
  `Cache-Control: public, max-age=31536000, immutable` and returning players do not download it
  again until you rebuild. `products.json` holds the new name in a `"wasm"` field; the loader
  (`X.js`) keeps its name and is revalidated on every visit like `index.html`, `main.js` and
  `products.json`.
* writes `X.<sha8>.wasm.gz` (gzip -9) and, when the `brotli` Python module or `brotli` command is
  installed (`pip install brotli`), `X.<sha8>.wasm.br`. Roughly a third to a half of the raw size
  travels over the network.
* records `wasmSize`, `wasmGzSize` and `wasmBrSize` (bytes) in `products.json`. The page's progress
  bar counts decoded bytes against `wasmSize`, so it stays correct whichever encoding the server
  picks, and it shows the compressed transfer size when it is used.

Serving them is the server's job. `web/serve.py` does it by itself: when `F.br` or `F.gz` sits next
to `F`, the client accepts that encoding and sent no `Range` header, it sends the precompressed file
with `Content-Encoding` and `Vary: Accept-Encoding`; hashed files get the immutable `Cache-Control`
and html/js/json get `no-cache`. For other servers see the nginx and Caddy snippets below.

The browser keeps the 120 MiB file in its HTTP cache only as long as the cache has room (Chrome limits
how big a single cached entry may be relative to the whole cache), so a repeat visitor may still
download it again on a small or crowded profile. Older sites that were built without hashing keep
working: with no `"wasm"` field the page falls back to `X.wasm` and revalidates it each time.

## Let other people play

### Why HTTPS

Browsers expose WebGPU only to *secure contexts*: `https://` pages, plus `http://localhost` and
`http://127.0.0.1` on the same machine. `http://192.168.1.20:8080` from a phone or another PC is not a
secure context, so `navigator.gpu` does not exist there and the page says WebGPU is missing, however
the server is bound. Serving the game to other devices therefore needs HTTPS. The options below go from
easiest to most robust.

### `serve.py --https --lan`: a self-signed certificate on your own network

```sh
web/host.sh --https                      # or: python3 web/serve.py --https --lan
```

`serve.py` listens on `127.0.0.1` by default so a plain `python3 web/serve.py` is private to your
computer; `--lan` (the same as `--bind 0.0.0.0`) opens it to the network, and `web/host.sh` already
binds all interfaces. `--https` creates a self-signed certificate the first time, caches it in
`web/.certs/` (git-ignored; delete the folder to start over) and reuses it. The certificate is valid
for `localhost`, `127.0.0.1`, `::1`, this machine's host name and its LAN IPv4 addresses; add more
names with `--san game.example.lan` (repeatable). It is made with `openssl` when that is on `PATH`, and
by a small built-in generator otherwise, so Windows needs nothing extra. It is renewed automatically
when it nears expiry or when the machine gets a new address (the warning then comes back once).

On start `serve.py` prints the addresses to open, for example:

```
Open on this computer:   https://localhost:8080/
Open from other devices: https://192.168.1.20:8080/
SHA-256 fingerprint: 19:47:47:C6:...
```

**Expect a browser warning.** Nobody the browser trusts vouches for a self-signed certificate, so
Chrome and Edge show "Your connection is not private" (`NET::ERR_CERT_AUTHORITY_INVALID`) on the first
visit from each device. Choose **Advanced**, then **Proceed to 192.168.1.20 (unsafe)**. That is fine on
your own network, and you can compare the fingerprint on the warning page's certificate details with the
one `serve.py` printed. Once you proceed, the page is still a secure context, so WebGPU works (this
is covered by `web/tests/https_browser_test.mjs`). The saves of such a page are stored per address:
`https://192.168.1.20:8080` and `https://localhost:8080` do not share them.

To avoid the warning, give `serve.py` a certificate your devices already trust:

```sh
python3 web/serve.py --cert fullchain.pem --key privkey.pem --lan --port 443
```

(for example a real certificate for a name that points at this machine, or one from a local CA such as
[mkcert](https://github.com/FiloSottile/mkcert) whose root you installed on the devices). `--cert` alone
also works when the key is inside the same file.

The Python server is meant for a handful of players. For a public site use one of the following.

### Caddy (automatic HTTPS)

[Caddy](https://caddyserver.com/) obtains and renews a certificate by itself for a real domain name
that points at your server (ports 80 and 443 reachable). A `Caddyfile` for the built site:

```caddyfile
game.example.com {
	root * /srv/wiicompiled/dist

	# The page and loaders are revalidated; the content-hashed wasm never changes.
	@text path / *.html *.js *.css *.json
	header @text Cache-Control "no-cache"
	@wasm path *.wasm *.wasm.gz *.wasm.br
	header @wasm Cache-Control "public, max-age=31536000, immutable"

	# Compress only the small text files on the fly; disc/ and mods/ must stay uncompressed so Range works.
	encode @text zstd gzip

	file_server {
		# Send X.br / X.gz next to X (the precompressed wasm) with Content-Encoding.
		precompressed br gzip
	}
}
```

`file_server` supports `Range` requests out of the box. Run it with `caddy run --config Caddyfile`
(or `caddy start`). For a machine without a public name, `tls internal` in the site block makes Caddy
issue certificates from its own local CA; each device must then trust that CA, which is the same work
as importing an mkcert root.

### Cloudflare Tunnel

A tunnel gives your local server a public HTTPS address without opening ports or owning a domain. The
quick, account-less form is for trying things out:

```sh
python3 web/serve.py                        # or web/host.sh --serve-only
cloudflared tunnel --url http://localhost:8080
```

`cloudflared` prints a random `https://<words>.trycloudflare.com` address that anyone can open. Quick
tunnels have no uptime promise; for a permanent address create a named tunnel in your Cloudflare
account (`cloudflared tunnel login`, `cloudflared tunnel create`, then route a hostname to it, see
Cloudflare's documentation). The game's traffic is mostly large binary files, so check Cloudflare's
terms for your plan before sending a lot of it through their network.

### Tailscale

If your players are on your [Tailscale](https://tailscale.com/) network, `tailscale serve` publishes the
local server over HTTPS with a real certificate for your machine's `*.ts.net` name (HTTPS has to be
enabled once in the Tailscale admin console):

```sh
python3 web/serve.py                        # or web/host.sh --serve-only
tailscale serve --bg 8080                   # prints https://<machine>.<tailnet>.ts.net/
tailscale serve status
tailscale serve reset                       # stop
```

Only devices on your tailnet can open that address. To make it public use `tailscale funnel --bg 8080`
instead (it has to be allowed for your tailnet in the admin console).

### nginx

Serve the precompressed wasm with `gzip_static` (built in) and `brotli_static` (the third-party
`ngx_brotli` module; leave it out if you do not have it), and keep Range working for the disc:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name game.example.com;
    # ssl_certificate / ssl_certificate_key: for example from certbot
    root /srv/wiicompiled/dist;

    # The disc and mod tree: no on-the-fly compression, so Range responses stay exact.
    location ~ ^/(disc|mods)/ {
        gzip off;
    }

    # Content-hashed wasm: cache forever and send X.wasm.gz / X.wasm.br when the client accepts it
    # (nginx adds "Vary: Accept-Encoding" with gzip_vary).
    location ~ \.wasm$ {
        gzip_static on;
        brotli_static on;        # remove if ngx_brotli is not installed
        gzip_vary on;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Everything else small: always revalidate, compress text on the fly.
    location / {
        gzip on;
        gzip_types text/css application/javascript text/javascript application/json;
        add_header Cache-Control "no-cache";
    }
}
```

(`add_header` inside a `location` replaces the ones from outer blocks, which is why each location
sets its own. Current nginx lists `application/wasm wasm;` in its stock `mime.types`; if yours does
not, add that line there rather than declaring a new `types` block, which would replace the whole table.) Check it with `curl -sI -H 'Accept-Encoding: gzip' https://game.example.com/WiiCompiled.<hash>.wasm`:
you should see `Content-Encoding: gzip` and the `immutable` Cache-Control, and
`curl -sI -H 'Range: bytes=0-9' https://game.example.com/disc/sys/main.dol` should answer `206`.

### Docker

The container's network addresses are not your LAN's, and its certificate folder is not kept between
runs, so put Caddy or a tunnel in front of `docker compose up` rather than using `--https` inside it.

## For players

* **Browser:** Chrome or Edge 137 or newer, on desktop. The page checks for
  WebGPU and WebAssembly JSPI and says what is missing. Firefox and Safari will
  work once they ship both.
* **Controls:** keyboard, or any gamepad the browser's Gamepad API sees. Press
  `?` or `H` on the page for the controls overlay.
* **Saves:** stored per browser in IndexedDB on the player's own machine.
  Clearing site data deletes them, and nothing is uploaded to the server.
* **One tab at a time:** two tabs of the same site share one save store. The first tab owns it
  (through a Web Lock); a second tab opened while the first is running still plays, but its
  progress is not saved, and it shows a banner saying so. Close the other tab and press Reload to
  take over. (Browsers without Web Locks keep the old behaviour: the tabs can overwrite each
  other's saves, and the console says so.)
* **Online play:** not available in the browser. The web build has no network
  stack.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Your browser is missing WebGPU / JSPI" | Older browser, Firefox/Safari, or the page is not on HTTPS/localhost |
| WebGPU missing only on other devices | The address is plain `http://`; serve it over HTTPS ([Let other people play](#let-other-people-play)) |
| "Your connection is not private" | The self-signed certificate of `serve.py --https`; choose Advanced, then Proceed, or use a trusted certificate |
| Banner "This game is open in another tab; progress here won't be saved" | Another tab of the same site owns the saves; close it and reload |
| Error overlay mentions `disc-manifest.json` | `disc/` or the manifest was not uploaded next to `index.html` |
| Very slow start, huge transfer | The server ignores `Range` (look for whole-file 200 responses to `disc/` requests) |
| The wasm downloads in full on every visit | The server does not send the `immutable` Cache-Control for `*.wasm`, or the browser cache is too small |
| Build stops at the hash check | The game files are not an unmodified PAL `RMCP01` copy |
| Build killed / out of memory | Translation and compilation need several GB of RAM; lower `--jobs` |

The error overlay has a **Copy details** button. Include its output when you
report a problem. It lists the first occurrence of each distinct error-like console line (with a
count) and the last 200 console lines, so a failure early in the start-up is still in it.
