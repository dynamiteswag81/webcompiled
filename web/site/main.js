// WebCompiled web frontend: compatibility check, loading screen, click-to-start gate,
// controls help, error overlay. Plain script, no dependencies, no network access besides the
// game's own files (same origin).
//
// Startup sequence
//   1. check WebGPU + JSPI support (clear message naming Chrome/Edge 137+ when missing)
//   2. read products.json (optional); with several products ask which one to play (or honour
//      ?product=ID); the choice sets Module.mkwProduct and which glue/.wasm pair is used
//   3. fetch the .wasm ourselves so we can show real download progress; it is handed to the
//      Emscripten glue through Module.wasmBinary, so it is not downloaded twice. products.json
//      names a content-hashed file (WiiCompiled.<sha8>.wasm) that servers may cache forever and
//      compress (Content-Encoding br/gzip); progress is measured in decoded bytes against the
//      recorded raw size, so it is right with or without compressed transfer
//   4. show "Click to start" (a user gesture is required for audio to be allowed to start)
//   5. on click, load the glue script; Module.setStatus / monitorRunDependencies keep the
//      loading screen updated until the runtime is initialized
(function () {
  'use strict';

  // ---------------------------------------------------------------------------------------
  // Configuration (adjust here if the CMake target is renamed)
  // ---------------------------------------------------------------------------------------
  /** Emscripten glue script of the default product, relative to this page. */
  const DEFAULT_GLUE_SCRIPT = 'WiiCompiled.js';
  /**
   * Optional product list written by web/build.sh / host.sh next to index.html:
   *   [{"id":"WiiCompiled","title":"Mario Kart Wii","glue":"WiiCompiled.js",
   *     "wasm":"WiiCompiled.1a2b3c4d.wasm","wasmSize":127926271,"wasmGzSize":41000000,"wasmBrSize":33000000},
   *    {"id":"RetroRewind","title":"Retro Rewind","glue":"RetroRewind.js","modRoot":"mods/RetroRewind6", ...}]
   * "wasm" (content-hashed file name; absent = <glue minus .js>.wasm, always revalidated) and the
   * size fields (bytes: raw, gzip, brotli) are written by web/tools/precompress_dist.py.
   * With more than one entry the start screen asks which to play; with one entry or no file the
   * page behaves as a single-product site.
   */
  const PRODUCTS_FILE = 'products.json';
  const LAST_PRODUCT_KEY = 'wiicompiled.product';
  /** The glue script and its wasm module (<glue minus .js>.wasm) of the chosen product. */
  let glueScript = DEFAULT_GLUE_SCRIPT;
  let wasmFile = wasmNameFor(glueScript); // the name the glue asks for (also used in messages)
  let wasmUrl = wasmFile;                 // what is actually fetched (content-hashed when known)
  let wasmHashed = false;
  let wasmSizes = { raw: 0, gz: 0, br: 0 };
  function wasmNameFor(glue) { return glue.replace(/\.js$/i, '') + '.wasm'; }
  /**
   * Set to the exported factory name (e.g. 'createWiiCompiled') if the build uses
   * -sMODULARIZE -sEXPORT_NAME=...; leave null for the classic build where the glue
   * reads the global `Module` object defined below.
   */
  const MODULE_FACTORY = null;
  /** Number of (most recent) console lines kept for the error report. */
  const LOG_LINES = 200;
  /**
   * Besides the last LOG_LINES lines, the report keeps the first occurrence of each distinct
   * error-like line (numbers stripped when comparing), so boot noise cannot push out the root cause.
   * Number of distinct ones kept, and the longest text stored for each.
   */
  const MAX_FIRST_ERRORS = 100;
  const MAX_ERROR_TEXT = 1500;

  // ---------------------------------------------------------------------------------------
  // Console capture (installed first so the error report contains everything)
  // ---------------------------------------------------------------------------------------
  const logLines = [];
  const t0 = Date.now();

  function formatArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
    if (a === undefined) return 'undefined';
    try {
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch (_) {
      return String(a);
    }
  }

  // First occurrence of each distinct error-like console entry: key -> {stamp, level, text, count}.
  const firstErrors = new Map();
  let droppedErrorKinds = 0;
  const ERROR_LIKE = /\b(error|errors|exception|fatal|abort(ed)?|trap|unreachable|panic|assert(ion)?|uncaught|failed|failure|cannot|can't|could not|unable|out of memory|oom|corrupt|invalid)\b/i;

  /** Same message with numbers (addresses, sizes, offsets, counters, timestamps) normalized. */
  function errorKey(text) {
    return String(text).split('\n', 1)[0].replace(/0x[0-9a-f]+/gi, '#').replace(/\d+(\.\d+)?/g, '#').trim().slice(0, 300);
  }

  function noteError(stamp, level, text) {
    const key = errorKey(text);
    const hit = firstErrors.get(key);
    if (hit) { hit.count++; return; }
    if (firstErrors.size >= MAX_FIRST_ERRORS) { droppedErrorKinds++; return; }
    const trimmed = text.length > MAX_ERROR_TEXT ? text.slice(0, MAX_ERROR_TEXT) + ' …(truncated)' : text;
    firstErrors.set(key, { stamp, level: level.trim(), text: trimmed, count: 1 });
  }

  function pushLog(level, args) {
    const secs = ((Date.now() - t0) / 1000).toFixed(2).padStart(8, ' ');
    const text = Array.prototype.map.call(args, formatArg).join(' ');
    for (const line of text.split('\n')) logLines.push('[' + secs + '] ' + level + ' ' + line);
    if (logLines.length > LOG_LINES) logLines.splice(0, logLines.length - LOG_LINES);
    if (level.trim() === 'ERROR' || ERROR_LIKE.test(text.split('\n', 1)[0])) noteError(secs, level, text);
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      pushLog(level.toUpperCase().padEnd(5, ' '), arguments);
      original.apply(null, arguments);
    };
  }

  // ---------------------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const el = {
    stage: $('stage'),
    loader: $('loader'),
    checks: $('checks'),
    compatError: $('compat-error'),
    progressArea: $('progress-area'),
    progress: $('progress'),
    progressFill: $('progress-fill'),
    status: $('status'),
    start: $('btn-start'),
    startHint: $('start-hint'),
    productArea: $('product-area'),
    productList: $('product-list'),
    changeProduct: $('btn-change-product'),
    toolbar: $('toolbar'),
    help: $('help'),
    helpOpen: $('btn-help'),
    helpClose: $('btn-help-close'),
    fullscreen: $('btn-fullscreen'),
    gamepadStatus: $('gamepad-status'),
    error: $('error'),
    errorSummary: $('error-summary'),
    errorDetails: $('error-details'),
    copy: $('btn-copy'),
    copyResult: $('copy-result'),
    reload: $('btn-reload'),
    dismiss: $('btn-dismiss'),
  };

  let phase = 'checking';
  function setPhase(p) {
    phase = p;
    document.documentElement.dataset.phase = p; // also handy for automated tests
  }
  setPhase('checking');

  function setStatus(text) {
    el.status.textContent = text;
  }

  /** fraction: 0..1, or null/undefined for an indeterminate bar. */
  function setProgress(fraction) {
    if (fraction == null || !isFinite(fraction)) {
      el.progress.classList.add('indeterminate');
      el.progress.removeAttribute('aria-valuenow');
      el.progressFill.style.width = '';
    } else {
      const pct = Math.max(0, Math.min(1, fraction)) * 100;
      el.progress.classList.remove('indeterminate');
      el.progress.setAttribute('aria-valuenow', String(Math.round(pct)));
      el.progressFill.style.width = pct.toFixed(1) + '%';
    }
  }

  function showLoader(on) {
    el.loader.hidden = !on;
  }

  const mib = (n) => (n / 1048576).toFixed(1) + ' MiB';

  // ---------------------------------------------------------------------------------------
  // Error overlay
  // ---------------------------------------------------------------------------------------
  const errorRecords = [];
  const shownErrorKeys = new Set();
  let gpuInfoText = 'not queried';

  function buildReport() {
    const out = [];
    out.push('WebCompiled error report');
    out.push('time:       ' + new Date().toISOString());
    out.push('page:       ' + location.href);
    out.push('phase:      ' + phase);
    out.push('userAgent:  ' + navigator.userAgent);
    out.push('secure ctx: ' + window.isSecureContext);
    out.push('gpu:        ' + gpuInfoText);
    out.push('jspi:       ' + (typeof WebAssembly !== 'undefined' && typeof WebAssembly.Suspending === 'function'));
    out.push('screen:     ' + innerWidth + 'x' + innerHeight + ' @' + (window.devicePixelRatio || 1) + 'x');
    out.push('');
    out.push('--- errors ---');
    for (const rec of errorRecords) {
      out.push('[' + rec.kind + '] ' + rec.message);
      if (rec.stack) out.push(rec.stack);
      out.push('');
    }
    let total = droppedErrorKinds;
    for (const e of firstErrors.values()) total += e.count;
    out.push('--- first occurrence of each distinct error-like console line (' + firstErrors.size +
      ' kinds, ' + total + ' lines' + (droppedErrorKinds ? ', ' + droppedErrorKinds + ' more kinds not kept' : '') + ') ---');
    for (const e of firstErrors.values()) {
      const lines = e.text.split('\n');
      out.push('[' + e.stamp + '] ' + e.level.padEnd(5, ' ') + ' ' + lines[0] + (e.count > 1 ? '   (x' + e.count + ')' : ''));
      for (let i = 1; i < lines.length; i++) out.push('    ' + lines[i]);
    }
    out.push('');
    out.push('--- last ' + logLines.length + ' console lines ---');
    for (const line of logLines) out.push(line);
    return out.join('\n');
  }

  function showError(kind, message, stack) {
    message = String(message == null ? 'Unknown error' : message);
    console.error('[' + kind + '] ' + message + (stack ? '\n' + stack : ''));
    errorRecords.push({ kind, message, stack: stack ? String(stack) : '' });
    if (phase !== 'error') setPhase('error');
    const key = kind + '|' + message;
    el.errorSummary.textContent = errorRecords[0].message;
    el.errorDetails.value = buildReport();
    if (el.error.hidden && !shownErrorKeys.has(key)) {
      el.error.hidden = false;
      el.copy.focus();
    }
    shownErrorKeys.add(key);
  }

  function isBenign(message) {
    // Emscripten uses these for control flow; browsers emit this one for harmless layout loops.
    return /ResizeObserver loop/.test(message) || message === 'unwind';
  }

  window.addEventListener('error', function (ev) {
    // Resource load errors (img/script) do not bubble to window; those are handled where loaded.
    const message = ev.message || (ev.error && ev.error.message) || 'Script error';
    if (isBenign(message)) return;
    const where = ev.filename ? '\n    at ' + ev.filename + ':' + ev.lineno + ':' + ev.colno : '';
    showError('window.onerror', message, ((ev.error && ev.error.stack) || '') + (ev.error && ev.error.stack ? '' : where));
  });

  window.addEventListener('unhandledrejection', function (ev) {
    const r = ev.reason;
    if (r === 'unwind' || (r && r.name === 'ExitStatus' && r.status === 0)) return;
    const message = r instanceof Error ? r.name + ': ' + r.message : formatArg(r);
    if (isBenign(message)) return;
    showError('unhandledrejection', message, r && r.stack);
  });

  el.copy.addEventListener('click', async function () {
    const text = el.errorDetails.value;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (_) {
      try {
        el.errorDetails.focus();
        el.errorDetails.select();
        ok = document.execCommand('copy');
      } catch (_) { /* fall through */ }
    }
    el.copyResult.textContent = ok ? 'Copied to the clipboard.' : 'Copy failed; select the text above and copy it manually.';
  });
  el.reload.addEventListener('click', () => location.reload());
  el.dismiss.addEventListener('click', function () {
    el.error.hidden = true;
    if (phase === 'error' && wasRunning) setPhase('running');
    canvas.focus();
  });

  // ---------------------------------------------------------------------------------------
  // Help overlay
  // ---------------------------------------------------------------------------------------
  let helpReturnFocus = null;

  function setHelp(open) {
    if (open === !el.help.hidden) return;
    el.help.hidden = !open;
    if (open) {
      helpReturnFocus = document.activeElement;
      el.helpClose.focus();
    } else {
      const target = helpReturnFocus && document.contains(helpReturnFocus) && helpReturnFocus !== document.body ? helpReturnFocus : canvas;
      if (target && target.focus) target.focus();
    }
  }

  el.helpOpen.addEventListener('click', () => setHelp(true));
  el.helpClose.addEventListener('click', () => setHelp(false));
  el.help.addEventListener('click', (ev) => { if (ev.target === el.help) setHelp(false); });

  // Capture phase on window: runs before SDL's listeners so that, while the panel is open,
  // the game does not also react to the keys. (Keyboard mapping is not final; see index.html.)
  window.addEventListener('keydown', function (ev) {
    if (!el.error.hidden) return; // error overlay: normal browser behaviour (text selection etc.)
    const tag = ev.target && ev.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey;
    const toggleKey = plain && (ev.key === '?' || ev.key === 'h' || ev.key === 'H');
    if (!typing && toggleKey && !ev.repeat) {
      setHelp(el.help.hidden);
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    if (!el.help.hidden) {
      if (ev.key === 'Escape') {
        setHelp(false);
        ev.preventDefault();
      }
      if (ev.key !== 'Tab') ev.stopImmediatePropagation(); // keep keys away from the game
    }
  }, true);
  window.addEventListener('keyup', function (ev) {
    if (!el.help.hidden) ev.stopImmediatePropagation();
  }, true);

  function updateGamepads() {
    const pads = (navigator.getGamepads ? Array.from(navigator.getGamepads()) : []).filter(Boolean);
    el.gamepadStatus.textContent = pads.length
      ? pads.length + ' gamepad' + (pads.length > 1 ? 's' : '') + ' detected: ' + pads.map((p) => p.id).join('; ')
      : 'No gamepad detected.';
  }
  window.addEventListener('gamepadconnected', updateGamepads);
  window.addEventListener('gamepaddisconnected', updateGamepads);
  updateGamepads();

  // ---------------------------------------------------------------------------------------
  // Fullscreen
  // ---------------------------------------------------------------------------------------
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (el.stage.requestFullscreen) {
      el.stage.requestFullscreen().catch((e) => console.warn('fullscreen refused: ' + e));
    } else {
      console.warn('Fullscreen API not available');
    }
  }
  el.fullscreen.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', function () {
    el.fullscreen.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
    el.fullscreen.setAttribute('aria-pressed', document.fullscreenElement ? 'true' : 'false');
  });
  if (!el.stage.requestFullscreen) el.fullscreen.hidden = true;

  // Toolbar auto-hide: the toolbar sits over the canvas's top-right corner, where the in-game FPS
  // counter is drawn. It fades out after a few idle seconds and returns on pointer movement, touch,
  // or keyboard focus (Tab).
  const TOOLBAR_IDLE_MS = 3000;
  let toolbarTimer = 0;
  function hideToolbarWhenIdle() {
    if (el.toolbar.matches(':hover, :focus-within')) { // never hide under the pointer or focus
      toolbarTimer = setTimeout(hideToolbarWhenIdle, TOOLBAR_IDLE_MS);
      return;
    }
    el.toolbar.classList.add('idle');
  }
  function showToolbar() {
    el.toolbar.classList.remove('idle');
    clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(hideToolbarWhenIdle, TOOLBAR_IDLE_MS);
  }
  for (const type of ['mousemove', 'pointerdown', 'touchstart']) {
    el.stage.addEventListener(type, showToolbar, { passive: true });
  }
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Tab') showToolbar(); });

  // ---------------------------------------------------------------------------------------
  // Compatibility check
  // ---------------------------------------------------------------------------------------
  function addCheck(ok, label, detail) {
    const li = document.createElement('li');
    li.className = ok ? 'ok' : 'fail';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = ok ? '✓' : '✗';
    const body = document.createElement('span');
    body.append(label + (ok ? '' : ' is not available'));
    if (detail) {
      const d = document.createElement('div');
      d.className = 'detail';
      d.textContent = detail;
      body.append(d);
    }
    li.append(mark, body);
    el.checks.append(li);
    return ok;
  }

  async function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); });
    try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
  }

  async function checkCompatibility() {
    const problems = [];
    el.checks.hidden = false;
    el.checks.textContent = '';

    // WebAssembly + JSPI (JavaScript Promise Integration), shipped in Chrome/Edge 137.
    const wasmOk = typeof WebAssembly === 'object';
    const jspiOk = wasmOk && typeof WebAssembly.Suspending === 'function';
    if (!addCheck(jspiOk, 'WebAssembly JSPI (JavaScript Promise Integration)',
      jspiOk ? '' : (wasmOk ? 'WebAssembly.Suspending is missing.' : 'WebAssembly is disabled.'))) {
      problems.push('WebAssembly JSPI');
    }

    // WebGPU
    let adapter = null;
    let gpuDetail = '';
    let gpuOk = false;
    if (!navigator.gpu) {
      gpuDetail = window.isSecureContext
        ? 'navigator.gpu is missing.'
        : 'navigator.gpu is missing because this page is not a secure context. Use https:// or http://localhost.';
    } else {
      try {
        adapter = await withTimeout(navigator.gpu.requestAdapter(), 10000);
        if (!adapter) {
          gpuDetail = 'requestAdapter() returned no adapter (no usable GPU or WebGPU is blocked).';
        } else {
          gpuOk = true;
          let info = adapter.info || null;
          if (!info && typeof adapter.requestAdapterInfo === 'function') {
            try { info = await adapter.requestAdapterInfo(); } catch (_) { /* optional */ }
          }
          if (info) {
            gpuInfoText = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') || 'adapter present';
            gpuDetail = gpuInfoText;
          } else {
            gpuInfoText = 'adapter present';
          }
        }
      } catch (e) {
        gpuDetail = 'requestAdapter() failed: ' + (e && e.message || e);
      }
    }
    if (!addCheck(gpuOk, 'WebGPU', gpuDetail)) problems.push('WebGPU');
    if (!gpuOk) gpuInfoText = 'unavailable: ' + gpuDetail;

    return problems;
  }

  function showIncompatible(problems) {
    setPhase('incompatible');
    el.progressArea.hidden = true;
    el.compatError.hidden = false;
    el.compatError.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = 'This browser cannot run the game. ';
    el.compatError.append(strong,
      'Missing: ' + problems.join(' and ') + '. WiiCompiled needs WebGPU and WebAssembly JSPI, ' +
      'which are available in current Google Chrome or Microsoft Edge, version 137 or newer, on desktop. ' +
      'Other browsers may not support this combination yet.');
  }

  // ---------------------------------------------------------------------------------------
  // Products (base game, Retro Rewind, ...)
  // ---------------------------------------------------------------------------------------
  const SAFE_PATH = /^(?![\/.])(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.\-\/]+$/;

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (_) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (_) { /* private window, blocked storage */ }
  }

  /** Validate one products.json entry; returns a normalized product or null. */
  function normalizeProduct(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const glue = typeof raw.glue === 'string' ? raw.glue : '';
    if (!id || !/\.js$/i.test(glue) || !SAFE_PATH.test(glue)) return null;
    let modRoot = null;
    if (typeof raw.modRoot === 'string' && raw.modRoot) {
      const trimmed = raw.modRoot.replace(/\/+$/, '');
      if (!SAFE_PATH.test(trimmed)) return null;
      modRoot = trimmed;
    }
    // Content-hashed wasm name and its sizes (web/tools/precompress_dist.py); all optional.
    const wasm = typeof raw.wasm === 'string' && /\.wasm$/i.test(raw.wasm) && SAFE_PATH.test(raw.wasm) ? raw.wasm : null;
    const size = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
    return {
      id: id,
      title: typeof raw.title === 'string' && raw.title ? raw.title : id,
      glue: glue,
      wasm: wasm,
      wasmSizes: wasm ? { raw: size(raw.wasmSize), gz: size(raw.wasmGzSize), br: size(raw.wasmBrSize) } : { raw: 0, gz: 0, br: 0 },
      modRoot: modRoot,
      // Same naming build.sh uses for the disc: <modRoot>-manifest.json next to the mod tree.
      modManifest: modRoot ? modRoot + '-manifest.json' : null,
    };
  }

  /** products.json -> array of products; falls back to the single default product. */
  async function loadProducts() {
    const fallback = [{ id: 'WiiCompiled', title: 'Mario Kart Wii', glue: DEFAULT_GLUE_SCRIPT, wasm: null,
      wasmSizes: { raw: 0, gz: 0, br: 0 }, modRoot: null, modManifest: null }];
    try {
      const resp = await fetch(PRODUCTS_FILE, { cache: 'no-cache' });
      if (!resp.ok) return fallback;
      const list = await resp.json();
      const products = (Array.isArray(list) ? list : []).map(normalizeProduct).filter(Boolean);
      const seen = new Set();
      const unique = products.filter((p) => !seen.has(p.id) && seen.add(p.id));
      return unique.length ? unique : fallback;
    } catch (e) {
      console.warn('ignoring ' + PRODUCTS_FILE + ': ' + (e && e.message || e));
      return fallback;
    }
  }

  function applyProduct(product) {
    glueScript = product.glue;
    wasmFile = wasmNameFor(glueScript);
    wasmUrl = product.wasm || wasmFile;
    wasmHashed = !!product.wasm;
    wasmSizes = product.wasmSizes;
    // Read by the runtime (web/js libraries) to find the mod tree to overlay on the disc.
    Module.mkwProduct = { id: product.id, modRoot: product.modRoot, modManifest: product.modManifest };
    document.documentElement.dataset.product = product.id;
  }

  /** Resolves with the product to run: ?product=ID, else a click on the choice screen. */
  function chooseProduct(products) {
    if (products.length === 1) return Promise.resolve(products[0]);
    const wanted = new URLSearchParams(location.search).get('product');
    if (wanted) {
      const hit = products.find((p) => p.id.toLowerCase() === wanted.toLowerCase());
      if (hit) return Promise.resolve(hit);
      console.warn('unknown ?product=' + wanted + '; showing the product list');
    }
    const last = storageGet(LAST_PRODUCT_KEY);
    return new Promise(function (resolve) {
      setPhase('choosing');
      el.progressArea.hidden = true;
      el.productList.textContent = '';
      let preferred = null;
      for (const product of products) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'product';
        b.dataset.product = product.id;
        const name = document.createElement('span');
        name.className = 'product-title';
        name.textContent = product.title;
        b.append(name);
        if (product.modRoot) {
          const tag = document.createElement('span');
          tag.className = 'product-tag';
          tag.textContent = 'mod';
          b.append(tag);
        }
        if (product.id === last) { b.classList.add('last'); preferred = b; }
        b.addEventListener('click', function () {
          storageSet(LAST_PRODUCT_KEY, product.id);
          el.productArea.hidden = true;
          el.progressArea.hidden = false;
          resolve(product);
        });
        el.productList.append(b);
      }
      el.productArea.hidden = false;
      (preferred || el.productList.firstElementChild).focus();
    });
  }

  el.changeProduct.addEventListener('click', function () {
    const url = new URL(location.href);
    url.searchParams.delete('product');
    location.href = url.pathname + (url.search || '');
  });

  // ---------------------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------------------
  async function fetchWasm() {
    setStatus('Downloading ' + wasmFile + '…');
    setProgress(0);
    // A content-hashed name never changes content, so the browser cache may keep it; the plain name
    // (older builds) is revalidated every time.
    const resp = await fetch(wasmUrl, { cache: wasmHashed ? 'default' : 'no-cache' });
    if (!resp.ok) throw new Error('Could not download ' + wasmUrl + ' (HTTP ' + resp.status + ' ' + resp.statusText + ')');
    // With Content-Encoding (br/gzip) Content-Length counts the compressed bytes while the stream
    // yields decoded ones, so progress runs against the recorded raw size and the compressed size is
    // only shown as the amount that travels over the network.
    const encoding = (resp.headers.get('Content-Encoding') || '').trim().toLowerCase();
    const length = parseInt(resp.headers.get('Content-Length') || '0', 10) || 0;
    let total = wasmSizes.raw || (encoding ? 0 : length);
    const wire = encoding ? (encoding === 'br' ? wasmSizes.br : /^(x-)?gzip$/.test(encoding) ? wasmSizes.gz : 0) || length : 0;
    const wireNote = wire ? ' (' + mib(wire) + ' compressed transfer)' : '';
    if (!resp.body || !resp.body.getReader) {
      setProgress(null);
      return await resp.arrayBuffer();
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total && received > total) total = 0; // recorded size is stale: fall back to indeterminate
      if (total) {
        setProgress(received / total);
        setStatus('Downloading ' + wasmFile + ': ' + mib(received) + ' / ' + mib(total) + wireNote);
      } else {
        setProgress(null);
        setStatus('Downloading ' + wasmFile + ': ' + mib(received) + wireNote);
      }
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
    setProgress(1);
    return bytes.buffer;
  }

  let wasmBinary = null;
  let wasRunning = false;

  // Emscripten run-dependency / status tracking (loading screen after the click).
  let maxDependencies = 0;
  let emStatus = ''; // last non-empty text from Module.setStatus; it is more specific than the counter
  const Module = {
    canvas: canvas,
    print: function () { console.log.apply(console, arguments); },
    printErr: function () { console.error.apply(console, arguments); },
    locateFile: function (path, prefix) {
      if (path === wasmFile) return wasmUrl;
      return (prefix || '') + path;
    },
    setStatus: function (text) {
      emStatus = text || '';
      if (phase !== 'starting') return;
      if (!text) return;
      const m = /^(.*?)\s*\((\d+(?:\.\d+)?)\/(\d+)\)\s*$/.exec(text);
      if (m && Number(m[3]) > 0) {
        setProgress(Number(m[2]) / Number(m[3]));
        setStatus(m[1] + ' (' + m[2] + '/' + m[3] + ')');
      } else {
        setStatus(text);
      }
    },
    totalDependencies: 0,
    monitorRunDependencies: function (left) {
      this.totalDependencies = Math.max(this.totalDependencies, left);
      maxDependencies = this.totalDependencies;
      if (phase !== 'starting') return;
      if (left > 0) {
        if (!emStatus) {
          setProgress(1 - left / maxDependencies);
          setStatus('Preparing (' + (maxDependencies - left) + '/' + maxDependencies + ')');
        }
      } else if (!emStatus) {
        setProgress(null);
        setStatus('Starting…');
      }
    },
    onRuntimeInitialized: function () {
      console.log('runtime initialized');
      wasRunning = true;
      setPhase('running');
      showLoader(false);
      el.toolbar.hidden = false;
      showToolbar();
      canvas.focus();
    },
    onAbort: function (what) {
      showError('Module.onAbort', 'Aborted: ' + (what == null ? '(no reason)' : formatArg(what)), new Error().stack);
    },
    onMkwStorageReadOnly: function (message) { // raised by web/js/library_mkw_dvd.js (another tab owns the saves)
      showSaveBanner(message);
    },
    onMkwFatal: function (message) { // raised by web/js/library_mkw_host.js
      showError('guest-fatal', message);
    },
    onExit: function (code) {
      console.log('Module.onExit: ' + code);
      if (code !== 0) showError('Module.onExit', 'The game exited with status ' + code);
    },
  };
  window.Module = Module;

  // Shown when another tab of this site owns the save store (Web Locks): this tab only reads the
  // saves. Built in script so it works with any index.html.
  function showSaveBanner(message) {
    if (document.getElementById('save-banner')) return;
    const style = document.createElement('style');
    style.textContent =
      '#save-banner{position:fixed;left:0;right:0;top:0;z-index:50;display:flex;flex-wrap:wrap;gap:8px 12px;' +
      'align-items:center;justify-content:center;padding:8px max(16px,env(safe-area-inset-left));' +
      'background:#3a2a0a;color:#ffe9b8;border-bottom:1px solid var(--warn,#f0b14a);font-size:.9rem;text-align:center}' +
      '#save-banner[hidden]{display:none}' +
      '#save-banner button{font:inherit;padding:3px 10px;border-radius:999px;border:1px solid var(--warn,#f0b14a);' +
      'background:transparent;color:inherit;cursor:pointer}';
    const bar = document.createElement('div');
    bar.id = 'save-banner';
    bar.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = message || "This game is open in another tab; progress here won't be saved.";
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Reload';
    retry.title = 'Try again (works once the other tab is closed)';
    retry.addEventListener('click', () => location.reload());
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Dismiss';
    close.addEventListener('click', () => { bar.hidden = true; });
    bar.append(text, retry, close);
    document.head.append(style);
    document.body.append(bar);
  }

  // Small hooks for runtime code (JS libraries, EM_ASM) that wants to drive the loading screen,
  // e.g. while the first disc reads stream in: WiiCompiledUI.showLoading('Reading disc…', 0.4).
  window.WiiCompiledUI = {
    showLoading: function (text, fraction) { showLoader(true); el.start.hidden = true; el.startHint.hidden = true; setStatus(text || ''); setProgress(fraction); },
    hideLoading: function () { showLoader(false); },
    showError: function (message, detail) { showError('runtime', message, detail); },
  };

  function loadGlue() {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = glueScript;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + glueScript)); };
      document.body.appendChild(s);
    });
  }

  async function start() {
    el.start.hidden = true;
    el.changeProduct.hidden = true;
    el.startHint.hidden = true;
    el.progressArea.hidden = false;
    setPhase('starting');
    setProgress(null);
    setStatus('Starting…');
    Module.wasmBinary = wasmBinary;
    try {
      await loadGlue();
      if (MODULE_FACTORY) {
        const factory = window[MODULE_FACTORY];
        if (typeof factory !== 'function') throw new Error(glueScript + ' did not define ' + MODULE_FACTORY + '()');
        await factory(Module);
      }
    } catch (e) {
      showError('startup', e && e.message || e, e && e.stack);
    }
  }

  el.start.addEventListener('click', start);
  el.start.addEventListener('keydown', function (ev) { ev.stopPropagation(); });

  async function boot() {
    setStatus('Checking your browser…');
    setProgress(null);
    const problems = await checkCompatibility();
    if (problems.length) {
      showIncompatible(problems);
      return;
    }
    const products = await loadProducts();
    const product = await chooseProduct(products);
    applyProduct(product);
    el.changeProduct.hidden = products.length < 2;
    setPhase('downloading');
    try {
      wasmBinary = await fetchWasm();
    } catch (e) {
      showError('download', e && e.message || e, e && e.stack);
      setStatus('Download failed.');
      return;
    }
    setPhase('ready');
    el.progressArea.hidden = false;
    setStatus('Ready (' + mib(wasmBinary.byteLength) + ' downloaded).');
    el.start.hidden = false;
    el.startHint.hidden = false;
    el.start.focus();
  }

  boot().catch((e) => showError('boot', e && e.message || e, e && e.stack));
})();
