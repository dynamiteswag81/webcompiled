// WiiCompiled web frontend: compatibility check, loading screen, click-to-start gate,
// controls help, error overlay. Plain script, no dependencies, no network access besides the
// game's own files (same origin).
//
// Startup sequence
//   1. check WebGPU + JSPI support (clear message naming Chrome/Edge 137+ when missing)
//   2. fetch the .wasm ourselves so we can show real download progress; it is handed to the
//      Emscripten glue through Module.wasmBinary, so it is not downloaded twice
//   3. show "Click to start" (a user gesture is required for audio to be allowed to start)
//   4. on click, load the glue script; Module.setStatus / monitorRunDependencies keep the
//      loading screen updated until the runtime is initialized
(function () {
  'use strict';

  // ---------------------------------------------------------------------------------------
  // Configuration (adjust here if the CMake target is renamed)
  // ---------------------------------------------------------------------------------------
  /** Emscripten glue script emitted by the build, relative to this page. */
  const GLUE_SCRIPT = 'WiiCompiled.js';
  /** The wasm module that goes with it. Derived from GLUE_SCRIPT by default. */
  const WASM_FILE = GLUE_SCRIPT.replace(/\.js$/i, '') + '.wasm';
  /**
   * Set to the exported factory name (e.g. 'createWiiCompiled') if the build uses
   * -sMODULARIZE -sEXPORT_NAME=...; leave null for the classic build where the glue
   * reads the global `Module` object defined below.
   */
  const MODULE_FACTORY = null;
  /** Number of console lines kept for the error report. */
  const LOG_LINES = 200;

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

  function pushLog(level, args) {
    const secs = ((Date.now() - t0) / 1000).toFixed(2).padStart(8, ' ');
    const text = Array.prototype.map.call(args, formatArg).join(' ');
    for (const line of text.split('\n')) logLines.push('[' + secs + '] ' + level + ' ' + line);
    if (logLines.length > LOG_LINES) logLines.splice(0, logLines.length - LOG_LINES);
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
    out.push('WiiCompiled error report');
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
  // Loading
  // ---------------------------------------------------------------------------------------
  async function fetchWasm() {
    setStatus('Downloading ' + WASM_FILE + '…');
    setProgress(0);
    const resp = await fetch(WASM_FILE, { cache: 'no-cache' });
    if (!resp.ok) throw new Error('Could not download ' + WASM_FILE + ' (HTTP ' + resp.status + ' ' + resp.statusText + ')');
    const total = parseInt(resp.headers.get('Content-Length') || '0', 10) || 0;
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
      if (total) {
        setProgress(received / total);
        setStatus('Downloading ' + WASM_FILE + ': ' + mib(received) + ' / ' + mib(total));
      } else {
        setProgress(null);
        setStatus('Downloading ' + WASM_FILE + ': ' + mib(received));
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
      if (path === WASM_FILE) return WASM_FILE;
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
      canvas.focus();
    },
    onAbort: function (what) {
      showError('Module.onAbort', 'Aborted: ' + (what == null ? '(no reason)' : formatArg(what)), new Error().stack);
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
      s.src = GLUE_SCRIPT;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + GLUE_SCRIPT)); };
      document.body.appendChild(s);
    });
  }

  async function start() {
    el.start.hidden = true;
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
        if (typeof factory !== 'function') throw new Error(GLUE_SCRIPT + ' did not define ' + MODULE_FACTORY + '()');
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
