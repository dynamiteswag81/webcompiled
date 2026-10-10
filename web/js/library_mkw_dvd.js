// Disc streaming and save persistence for the WebAssembly build of WiiCompiled, linked with
// --js-library (and -lidbfs.js). C++ side: runtime/src/hle/storage/web_disc.cpp.
//
// Disc: the operator's static site holds the extracted DATA tree (`disc/sys`, `disc/files`)
// plus a build-time `disc-manifest.json` (web/tools/make_disc_manifest.py). Reads are HTTP
// Range requests awaited through JSPI (`__async: true`): the calling wasm stack is parked until
// the bytes arrive; the LRU block cache lives on the C++ side.
//
// Saves: `$HOME` (/home/web_user: Config.toml, the managed NAND, logs) is an IDBFS mount that is
// populated before main() runs and persisted to IndexedDB automatically after every file close,
// unlink, rename or mkdir (IDBFS autoPersist), plus on page hide.
//
// Module options (all optional):
//   mkwDiscManifestUrl  manifest URL, resolved against the page (default 'disc-manifest.json')
//   mkwDiscBaseUrl      disc tree URL; default: the manifest's "root" resolved against the
//                       manifest URL ('disc/' next to it)
//   mkwDiscRetries      attempts per request for network errors / 5xx (default 4)
//   mkwDiscPrefetchManifest  false: do not start fetching the manifest at module load
//   mkwPersistence      false keeps saves in memory only (default: on when IndexedDB exists)
//   mkwPersistentDir    mount point of the persistent store (default '/home/web_user')
//   onMkwStorageError   callback(message) for mount/sync failures
// Module helpers installed here:
//   Module.mkwStorageFlush()  -> Promise; persists the store now (e.g. before closing the tab)
//   Module.mkwStorageStatus   'persistent' | 'memory' | 'error' (after preRun)

addToLibrary({
  $MkwDvd__deps: ['$MkwStorage'],
  $MkwDvd__postset: 'MkwDvd.init();',
  $MkwDvd: {
    manifestUrl: null,
    manifestPromise: null,
    baseUrl: null,
    warnedNoRange: false,

    init() {
      MkwStorage.install();
      // Start the manifest download while the wasm module is still compiling.
      if (globalThis.fetch && Module['mkwDiscPrefetchManifest'] !== false) {
        MkwDvd.manifestPromise = MkwDvd.fetchManifest();
      }
    },

    pageUrl() {
      if (globalThis.document?.baseURI) return document.baseURI;
      if (globalThis.location?.href) return location.href;
      return undefined;
    },

    resolveUrl(url, base) {
      try {
        return new URL(url, base).href;
      } catch (e) {
        throw new Error(`cannot resolve URL "${url}"${base ? ` against ${base}` : ''} ` +
                        '(set Module.mkwDiscManifestUrl / mkwDiscBaseUrl to absolute URLs)');
      }
    },

    // Resolves to the C++ listing text (see mkw_dvd_load_manifest); never rejects.
    async fetchManifest() {
      try {
        const manifestUrl = MkwDvd.resolveUrl(
          Module['mkwDiscManifestUrl'] || 'disc-manifest.json', MkwDvd.pageUrl());
        MkwDvd.manifestUrl = manifestUrl;
        const response = await MkwDvd.fetchWithRetry(manifestUrl, {});
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText} for ${manifestUrl}`);
        }
        const manifest = await response.json();
        // Bracket access throughout: JSON field names must survive --closure.
        const files = manifest?.['files'];
        if (manifest?.['format'] !== 'wiicompiled-disc-manifest' || manifest['version'] !== 1 ||
            typeof files !== 'object' || files === null) {
          throw new Error(`${manifestUrl} is not a version 1 WiiCompiled disc manifest`);
        }
        let base = Module['mkwDiscBaseUrl']
          ? MkwDvd.resolveUrl(Module['mkwDiscBaseUrl'], MkwDvd.pageUrl())
          : MkwDvd.resolveUrl(manifest['root'] ?? 'disc/', manifestUrl);
        if (!base.endsWith('/')) base += '/';
        MkwDvd.baseUrl = base;

        const valid = (path) => typeof path == 'string' && path.length > 0 && !/[\t\n\r\0]/.test(path);
        const lines = [`MKWDISC\t1\t${base}`];
        for (const [path, size] of Object.entries(files)) {
          if (!valid(path) || !Number.isSafeInteger(size) || size < 0 || size > 0xFFFFFFFF) {
            throw new Error(`${manifestUrl}: invalid entry ${JSON.stringify(path)}: ${size}`);
          }
          lines.push(`F\t${size}\t${path}`);
        }
        for (const path of manifest['directories'] ?? []) {
          if (!valid(path)) throw new Error(`${manifestUrl}: invalid directory ${JSON.stringify(path)}`);
          lines.push(`D\t${path}`);
        }
        return lines.join('\n') + '\n';
      } catch (e) {
        const message = `could not load the disc manifest: ${e && e.message || e}`;
        err(`[dvd/web] ${message}`);
        return `ERROR\t${message.replace(/[\t\n\r]/g, ' ')}\n`;
      }
    },

    urlFor(relPath) {
      return MkwDvd.baseUrl + relPath.split('/').map(encodeURIComponent).join('/');
    },

    // fetch() with retries for network failures and 5xx/429 responses.
    async fetchWithRetry(url, init) {
      const attempts = Math.max(1, Module['mkwDiscRetries'] ?? 4);
      let lastError;
      for (let attempt = 0; attempt < attempts; ++attempt) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 150 * 4 ** (attempt - 1)));
        try {
          const response = await fetch(url, init);
          if (response.status >= 500 || response.status == 429) {
            lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
            continue;
          }
          return response;
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    },

    async read(relPath, offset, length, dest) {
      const url = MkwDvd.urlFor(relPath);
      let response;
      try {
        response = await MkwDvd.fetchWithRetry(url, {
          headers: { 'Range': `bytes=${offset}-${offset + length - 1}` },
        });
      } catch (e) {
        err(`[dvd/web] ${url}: ${e && e.message || e}`);
        return -2;
      }
      if (response.status == 404 || response.status == 410) return -1;
      if (response.status == 416) return 0; // range starts past the server's end of file
      if (response.status != 206 && response.status != 200) {
        err(`[dvd/web] ${url}: HTTP ${response.status} ${response.statusText}`);
        return -2;
      }

      let bytes;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (e) {
        err(`[dvd/web] ${url}: ${e && e.message || e}`);
        return -2;
      }
      let start = 0;
      if (response.status == 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('Content-Range') ?? '');
        if (range && Number(range[1]) != offset) {
          err(`[dvd/web] ${url}: asked for offset ${offset}, server sent ${range[0]}`);
          return -3;
        }
      } else {
        // The server ignored Range and sent the whole file: still correct, just slow.
        if (!MkwDvd.warnedNoRange) {
          MkwDvd.warnedNoRange = true;
          err(`[dvd/web] ${MkwDvd.baseUrl} does not honor HTTP Range requests; every disc read ` +
              'downloads the whole file. Host the site on a server with Range support.');
        }
        start = Math.min(offset, bytes.length);
      }
      const count = Math.min(length, bytes.length - start);
      // HEAPU8 is re-read after the awaits: memory may have grown meanwhile.
      HEAPU8.set(bytes.subarray(start, start + count), dest);
      return count;
    },
  },

  $MkwStorage__deps: ['$FS', '$IDBFS', '$addOnPreRun', '$addRunDependency', '$removeRunDependency'],
  $MkwStorage: {
    mount: null,
    installed: false,

    install() {
      if (MkwStorage.installed) return;
      MkwStorage.installed = true;
      Module['mkwStorageStatus'] = 'memory';
      Module['mkwStorageFlush'] = () => MkwStorage.flush();
      addOnPreRun(async () => {
        const dir = Module['mkwPersistentDir'] || '/home/web_user';
        if (Module['mkwPersistence'] === false || typeof indexedDB == 'undefined') {
          if (Module['mkwPersistence'] !== false) {
            err('[storage] IndexedDB is unavailable; saves and settings will not persist');
          }
          return;
        }
        addRunDependency('mkw-idbfs');
        try {
          FS.mkdirTree(dir);
          FS.mount(IDBFS, { autoPersist: true }, dir);
          await MkwStorage.sync(true);
          MkwStorage.mount = dir;
          Module['mkwStorageStatus'] = 'persistent';
          IDBFS.onAutoPersistStateChanged = (active) => {
            Module['onMkwStorageActivity']?.(active);
          };
          const flushOnHide = () => {
            if (globalThis.document?.visibilityState === 'hidden') MkwStorage.flush();
          };
          globalThis.addEventListener?.('pagehide', () => MkwStorage.flush());
          globalThis.document?.addEventListener('visibilitychange', flushOnHide);
        } catch (e) {
          MkwStorage.reportError(`could not open the persistent store at ${dir}: ${e && e.message || e}`);
          Module['mkwStorageStatus'] = 'error';
        } finally {
          removeRunDependency('mkw-idbfs');
        }
      });
    },

    sync(populate) {
      return new Promise((resolve, reject) => {
        FS.syncfs(populate, (error) => error ? reject(error) : resolve());
      });
    },

    reportError(message) {
      err(`[storage] ${message}`);
      Module['onMkwStorageError']?.(message);
    },

    // Never rejects: a failed sync is reported and leaves the in-memory data intact.
    async flush() {
      if (!MkwStorage.mount) return false;
      try {
        await MkwStorage.sync(false);
        return true;
      } catch (e) {
        MkwStorage.reportError(`saving to IndexedDB failed: ${e && e.message || e}`);
        return false;
      }
    },
  },

  mkw_dvd_load_manifest__deps: ['$MkwDvd', '$stringToNewUTF8'],
  mkw_dvd_load_manifest__async: true,
  mkw_dvd_load_manifest: async () => {
    MkwDvd.manifestPromise ??= MkwDvd.fetchManifest();
    const listing = await MkwDvd.manifestPromise;
    return stringToNewUTF8(listing);
  },

  mkw_dvd_read__deps: ['$MkwDvd', '$UTF8ToString'],
  mkw_dvd_read__async: true,
  mkw_dvd_read: (relPath, offset, length, dest) =>
    MkwDvd.read(UTF8ToString(relPath), offset, length, dest),

  // Persists the save store now and waits for IndexedDB. Returns 1 on success, 0 when there is
  // no persistent store or the sync failed. Optional: autoPersist already syncs after writes.
  mkw_storage_flush__deps: ['$MkwStorage'],
  mkw_storage_flush__async: true,
  mkw_storage_flush: async () => (await MkwStorage.flush()) ? 1 : 0,

  // 1 when $HOME is backed by IndexedDB, 0 when saves only live in memory.
  mkw_storage_is_persistent__deps: ['$MkwStorage'],
  mkw_storage_is_persistent: () => MkwStorage.mount ? 1 : 0,
});
