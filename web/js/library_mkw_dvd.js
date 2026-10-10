// Disc / mod-pack streaming and save persistence for the WebAssembly build of WiiCompiled,
// linked with --js-library (and -lidbfs.js). C++ side: runtime/src/hle/storage/web_disc.cpp.
//
// Streamed trees ("mounts"): the operator's static site holds the extracted DATA tree
// (`disc/sys`, `disc/files`) plus a build-time `disc-manifest.json`, and for a modded product the
// mod pack (`mods/RetroRewind6/`) plus `mods/RetroRewind6-manifest.json`
// (web/tools/make_disc_manifest.py). Reads are HTTP Range requests awaited through JSPI
// (`__async: true`): the calling wasm stack is parked until the bytes arrive; the LRU block cache
// lives on the C++ side. Mount ids match WebDisc::Mount (0 = disc at /disc, 1 = mod pack at
// /mods/<last segment of modRoot>).
//
// Saves: `$HOME` (/home/web_user: Config.toml, the managed NAND, Riivolution saves) is an IDBFS
// mount that is populated before main() runs and persisted to IndexedDB automatically after
// every file close, unlink, rename or mkdir (IDBFS autoPersist), plus on page hide.
//
// Two tabs of one origin share that IndexedDB store, so before mounting it the page takes an
// exclusive Web Lock (navigator.locks, name 'webcompiled-saves') and holds it for the life of the
// document. The first tab gets the lock and persists as above. A later tab cannot get it (it waits
// mkwStorageLockWaitMs, so a reload of the owning tab still works) and runs READ-ONLY: it loads the
// saves that are in IndexedDB but never writes back (no autoPersist, no syncfs), and
// Module.onMkwStorageReadOnly(message) lets the page say so. Without navigator.locks (old browser,
// insecure context) it behaves as before, with a console warning. The lock is acquired inside the
// same run dependency as the mount, so it delays main() but cannot deadlock startup.
//
// Module options (all optional):
//   mkwDiscManifestUrl  disc manifest URL, resolved against the page (default 'disc-manifest.json')
//   mkwDiscBaseUrl      disc tree URL; default: the manifest's "root" resolved against the
//                       manifest URL ('disc/' next to it)
//   mkwProduct          {id: 'WiiCompiled' | 'RetroRewind', modRoot: 'mods/RetroRewind6'};
//                       modRoot (page-relative) enables the mod mount
//   mkwModManifestUrl   mod manifest URL (default modRoot + '-manifest.json')
//   mkwModBaseUrl       mod tree URL (default: that manifest's "root", i.e. modRoot + '/')
//   mkwDiscRetries      attempts per request for network errors / 5xx (default 4)
//   mkwDiscPrefetchManifest  false: do not start fetching manifests at module load
//   mkwPersistence      false keeps saves in memory only (default: on when IndexedDB exists)
//   mkwPersistentDir    mount point of the persistent store (default '/home/web_user')
//   mkwStorageLock      false skips the Web Lock (two tabs may then overwrite each other's saves)
//   mkwStorageLockName  lock name (default 'webcompiled-saves')
//   mkwStorageLockWaitMs how long to wait for the lock before going read-only (default 1500)
//   onMkwStorageError   callback(message) for mount/sync failures
//   onMkwStorageReadOnly callback(message) when another tab owns the save store (read-only mode)
// Module helpers installed here:
//   Module.mkwStorageFlush()  -> Promise; persists the store now (e.g. before closing the tab)
//   Module.mkwStorageStatus   'persistent' | 'readonly' | 'memory' | 'error' (after preRun)

addToLibrary({
  $MkwDvd__deps: ['$MkwStorage'],
  $MkwDvd__postset: 'MkwDvd.init();',
  $MkwDvd: {
    // Per mount: {label, manifestPromise, baseUrl}; index = WebDisc::Mount.
    mounts: [],
    warnedNoRange: false,

    init() {
      MkwStorage.install();
      MkwDvd.mounts = [{ label: 'disc' }, { label: 'mod' }];
      // Start the manifest downloads while the wasm module is still compiling.
      if (globalThis.fetch && Module['mkwDiscPrefetchManifest'] !== false) {
        MkwDvd.manifest(0);
        if (MkwDvd.modRoot()) MkwDvd.manifest(1);
      }
    },

    // Module.mkwProduct.modRoot without trailing slashes, or '' when the page has no mod.
    modRoot() {
      const root = Module['mkwProduct']?.['modRoot'];
      return typeof root == 'string' ? root.replace(/[\/\\]+$/, '') : '';
    },

    modMountName() {
      const name = MkwDvd.modRoot().split(/[\/\\]/).pop() ?? '';
      return name === '.' || name === '..' ? '' : name;
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
                        '(set Module.mkwDiscManifestUrl / mkwModManifestUrl to absolute URLs)');
      }
    },

    // {manifestUrl, baseUrl (explicit override or null), defaultRoot} for a mount.
    sourceFor(mount) {
      if (mount == 0) {
        return {
          manifestUrl: Module['mkwDiscManifestUrl'] || 'disc-manifest.json',
          baseUrl: Module['mkwDiscBaseUrl'] || null,
          defaultRoot: 'disc/',
        };
      }
      const root = MkwDvd.modRoot();
      if (!root && !Module['mkwModManifestUrl']) {
        throw new Error('this page configures no mod pack (Module.mkwProduct.modRoot)');
      }
      return {
        manifestUrl: Module['mkwModManifestUrl'] || `${root}-manifest.json`,
        baseUrl: Module['mkwModBaseUrl'] || null,
        defaultRoot: `${MkwDvd.modMountName()}/`,
      };
    },

    manifest(mount) {
      const state = MkwDvd.mounts[mount];
      return state.manifestPromise ??= MkwDvd.fetchManifest(mount);
    },

    // Resolves to the C++ listing text (see mkw_dvd_load_manifest); never rejects.
    async fetchManifest(mount) {
      const state = MkwDvd.mounts[mount];
      try {
        const source = MkwDvd.sourceFor(mount);
        const manifestUrl = MkwDvd.resolveUrl(source.manifestUrl, MkwDvd.pageUrl());
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
        let base = source.baseUrl
          ? MkwDvd.resolveUrl(source.baseUrl, MkwDvd.pageUrl())
          : MkwDvd.resolveUrl(manifest['root'] ?? source.defaultRoot, manifestUrl);
        if (!base.endsWith('/')) base += '/';
        state.baseUrl = base;

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
        const message = `could not load the ${state.label} manifest: ${e && e.message || e}`;
        err(`[dvd/web] ${message}`);
        return `ERROR\t${message.replace(/[\t\n\r]/g, ' ')}\n`;
      }
    },

    urlFor(mount, relPath) {
      return MkwDvd.mounts[mount].baseUrl + relPath.split('/').map(encodeURIComponent).join('/');
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

    async read(mount, relPath, offset, length, dest) {
      if (!MkwDvd.mounts[mount]?.baseUrl) return -2; // manifest never loaded
      const url = MkwDvd.urlFor(mount, relPath);
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
          err(`[dvd/web] ${MkwDvd.mounts[mount].baseUrl} does not honor HTTP Range requests; every ` +
              'read downloads the whole file. Host the site on a server with Range support.');
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
    readOnly: false,

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
          // 'held' | 'busy' (another tab owns the saves) | 'unsupported' (no navigator.locks)
          const lock = await MkwStorage.acquireLock();
          const readOnly = lock === 'busy';
          FS.mkdirTree(dir);
          FS.mount(IDBFS, { autoPersist: !readOnly }, dir);
          await MkwStorage.sync(true);
          if (readOnly) {
            // Saves are visible but this tab never writes them back: MkwStorage.mount stays null,
            // so flush() is a no-op and no autoPersist/pagehide sync can run.
            MkwStorage.readOnly = true;
            Module['mkwStorageStatus'] = 'readonly';
            const message = "This game is open in another tab; progress here won't be saved.";
            err(`[storage] ${message}`);
            Module['onMkwStorageReadOnly']?.(message);
            return;
          }
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

    // Takes the exclusive save-store lock and keeps it until the document goes away (the callback
    // returns a promise that never settles). Never rejects.
    acquireLock() {
      if (Module['mkwStorageLock'] === false) return Promise.resolve('unsupported');
      const locks = globalThis.navigator?.locks;
      if (!locks || typeof locks.request != 'function') {
        console.warn('[storage] navigator.locks is unavailable (old browser or insecure context); ' +
                     "several tabs of this game can overwrite each other's saves");
        return Promise.resolve('unsupported');
      }
      const name = Module['mkwStorageLockName'] || 'webcompiled-saves';
      const waitMs = Module['mkwStorageLockWaitMs'] ?? 1500;
      return new Promise((resolve) => {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), waitMs);
        locks.request(name, { signal: abort.signal }, () => {
          clearTimeout(timer);
          resolve('held');
          return new Promise(() => {});
        }).catch((e) => {
          clearTimeout(timer);
          if (e && e.name === 'AbortError') {
            resolve('busy');
          } else {
            console.warn(`[storage] Web Lock request failed (${e && e.message || e}); continuing without it`);
            resolve('unsupported');
          }
        });
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
  mkw_dvd_load_manifest: async (mount) => stringToNewUTF8(await MkwDvd.manifest(mount)),

  mkw_dvd_read__deps: ['$MkwDvd', '$UTF8ToString'],
  mkw_dvd_read__async: true,
  mkw_dvd_read: (mount, relPath, offset, length, dest) =>
    MkwDvd.read(mount, UTF8ToString(relPath), offset, length, dest),

  // Synchronous: the mod mount name ('RetroRewind6') or null when the page configures no mod.
  mkw_dvd_mod_mount_name__deps: ['$MkwDvd', '$stringToNewUTF8'],
  mkw_dvd_mod_mount_name: () => {
    const name = MkwDvd.modMountName();
    return name ? stringToNewUTF8(name) : 0;
  },

  // Persists the save store now and waits for IndexedDB. Returns 1 on success, 0 when there is
  // no persistent store or the sync failed. Optional: autoPersist already syncs after writes.
  mkw_storage_flush__deps: ['$MkwStorage'],
  mkw_storage_flush__async: true,
  mkw_storage_flush: async () => (await MkwStorage.flush()) ? 1 : 0,

  // 1 when $HOME is backed by IndexedDB, 0 when saves only live in memory.
  mkw_storage_is_persistent__deps: ['$MkwStorage'],
  mkw_storage_is_persistent: () => MkwStorage.mount ? 1 : 0,

  // 1 when another tab owns the save store and this one only reads it (nothing is written back).
  mkw_storage_is_readonly__deps: ['$MkwStorage'],
  mkw_storage_is_readonly: () => MkwStorage.readOnly ? 1 : 0,
});
