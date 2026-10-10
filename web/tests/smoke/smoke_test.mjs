// Drives the real web product (built against the synthetic translation) through startup in
// headless Chromium and reports the furthest milestone reached.
//
//   node web/tests/smoke/smoke_test.mjs URL LOGFILE [TIMEOUT_SECONDS] [FRAMES]
//
// FRAMES (default 0) is the length of the synthetic entry point's GXCopyDisp frame loop
// (make_synthetic_generated.py --frames). When it is non-zero the driver also checks the page
// visibility handling (docs/web-test-report.md C2/C3):
//   * startup with the page hidden and the canvas 0x0: aurora must wait for a visible, laid-out
//     canvas before creating the surface, then start normally once it is shown;
//   * hiding the page mid-run: presented frames (Module.mkwFramesPresented) must stop, the runtime
//     must report itself parked (Module.mkwPaused), nothing may trap, and frames must resume after
//     the page is shown again.
// The page is hidden for real by bringing a second page of the same browser context to the front;
// if headless Chromium does not report that as document.visibilityState 'hidden', the driver falls
// back to overriding visibilityState and dispatching visibilitychange (and says so in the log).
//
// URL serves web/site + WiiCompiled.js/.wasm (run_smoke.sh does that with web/serve.py). Every
// console line, page error and the final verdict go to LOGFILE with fs.appendFileSync, and the
// script ends with process.exit: browser.close() can hang while a JSPI stack is suspended.
//
// Exit code 0: startup reached the expected stop (the runtime's own "DVD data is unavailable"
// fatal report, shown in the page's error overlay) without a trap, abort, hang or stray JS
// exception before it. Anything else exits 1 and names the last milestone that was reached.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const [url, logFile, timeoutArg, framesArg] = process.argv.slice(2);
if (!url || !logFile) {
  console.error('usage: smoke_test.mjs URL LOGFILE [TIMEOUT_SECONDS] [FRAMES]');
  process.exit(2);
}
const timeoutMs = Number(timeoutArg || 180) * 1000;
const expectedFrames = Number(framesArg || 0);
fs.writeFileSync(logFile, '');
const t0 = Date.now();
function log(line) {
  const text = `[${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}] ${line}`;
  fs.appendFileSync(logFile, text + '\n');
  return text;
}

// Ordered startup milestones; each is matched against console output (or a page state).
const MILESTONES = [
  { id: 'page-ready', what: 'page compatibility check passed and the .wasm downloaded (Click to start)' },
  { id: 'module-instantiated', what: 'Emscripten runtime initialized (embedded /app files mounted)', re: /^runtime initialized$/ },
  { id: 'jspi-main', what: 'main() running under JSPI; Config.toml looked up under $HOME', re: /\[runtime-config\] \/home\/web_user\/.*(not found|loaded)/ },
  { id: 'guest-memory', what: 'guest memory initialized from the synthetic data sections (#embed blobs)', re: /Loaded _init \(\d+ bytes\) @ 0x800060A4/ },
  { id: 'static-ctors', what: 'static constructor scan finished', re: /Executed \d+ static constructors\./ },
  { id: 'aurora-webgpu', what: 'aurora_initialize succeeded on browser WebGPU (#canvas)', re: /graphics backend: (auto|webgpu)/i },
  { id: 'video-config', what: 'video / surface configured after aurora init', re: /\[runtime-config\] video\.widescreen=/ },
  { id: 'dvd-stop', what: 'translated entry point ran and DVDInit stopped cleanly: no disc data configured', re: /\[dvd\] ERROR: (No DVD root is configured|Configured DVD root is not an extracted DATA directory|.*(manifest|disc tree|disc-manifest))/i },
  { id: 'fatal-reported', what: 'runtime fatal report reached the page error overlay', re: /DVD data is unavailable/ },
  // Visibility checks (only with a frame loop; see the header). Not startup order either.
  { id: 'hidden-start-waited', post: true, frames: true, what: 'started hidden with a 0x0 canvas: aurora waited for the canvas, then initialized once shown' },
  { id: 'frames-presented', post: true, frames: true, what: 'the frame loop presented frames through GXCopyDisp / VI_HLE_PresentFrame' },
  { id: 'hidden-parked', post: true, frames: true, what: 'page hidden mid-run: frames stopped and the runtime parked (no trap)' },
  { id: 'resumed', post: true, frames: true, what: 'page shown again: the runtime resumed and presented more frames' },
  // Checked after the stop through Module.FS (not startup order, so never the "furthest" one).
  { id: 'app-assets', post: true, what: 'embedded /app assets present (dsp_coef.bin, wii_bootstrap/)' },
  { id: 'home-config', post: true, what: 'Config.toml written under $HOME (/home/web_user)' },
];
for (let i = MILESTONES.length - 1; i >= 0; --i) {
  if (MILESTONES[i].frames && !expectedFrames) MILESTONES.splice(i, 1);
}
const reached = new Set();
function reach(id) {
  if (reached.has(id)) return;
  reached.add(id);
  log(`MILESTONE ${id}: ${MILESTONES.find((m) => m.id === id).what}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
function noteLine(text) {
  lines.push(text);
  for (const m of MILESTONES) {
    if (m.re && !reached.has(m.id) && m.re.test(text)) {
      reached.add(m.id);
      log(`MILESTONE ${m.id}: ${m.what}`);
    }
  }
}

// Things that must never happen: traps, aborts, JSPI errors, stray exceptions. The page reports
// its own error kinds as "[kind] message" (web/site/main.js showError); only the runtime's fatal
// report ("[guest-fatal]") and its exit status are expected, and only after the DVD stop.
const BAD = [
  /RuntimeError/, /SuspendError/, /trying to suspend/i, /unreachable/, /Aborted\(/,
  /memory access out of bounds/, /Uncaught/, /thread constructor failed/, /Resource temporarily unavailable/,
  /^\[(Module\.onAbort|window\.onerror|unhandledrejection|startup|boot|download)\]/,
];

const pw = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
  : '/opt/node-tools/node_modules/playwright/index.mjs');
const { chromium } = pw.default ?? pw;

let verdict = 1;
try {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const badLines = [];
  page.on('console', (msg) => {
    for (const line of msg.text().split('\n')) {
      log(`console.${msg.type()}: ${line}`);
      noteLine(line);
      if (BAD.some((re) => re.test(line))) badLines.push((reached.has('dvd-stop') ? '(after the stop) ' : '') + line);
      else if (!reached.has('dvd-stop') && /^\[(guest-fatal|Module\.onExit)\]/.test(line)) badLines.push(line);
    }
  });
  page.on('pageerror', (e) => {
    const text = `${e.name}: ${e.message}`;
    log(`pageerror: ${text}\n${e.stack || ''}`);
    noteLine(text);
    badLines.push((reached.has('dvd-stop') ? '(after the stop) ' : '') + text);
  });
  page.on('crash', () => { log('PAGE CRASHED'); badLines.push('page crashed'); });

  await page.goto(url);
  await page.waitForFunction(() => ['ready', 'incompatible', 'error'].includes(document.documentElement.dataset.phase), null, { timeout: 60000 });
  const firstPhase = await page.evaluate(() => document.documentElement.dataset.phase);
  log(`page phase: ${firstPhase}`);
  if (firstPhase !== 'ready') throw new Error(`page did not become ready (phase ${firstPhase}): ${await page.textContent('#loader')}`);
  reached.add('page-ready');
  log(`MILESTONE page-ready: ${MILESTONES[0].what}`);
  await page.click('#btn-start');

  // Page visibility helpers. `cover` is a second page of the same context: bringing it to the front
  // hides `page` the way switching tabs does.
  let cover = null;
  let emulatedHide = false;
  const visibility = () => page.evaluate(() => document.visibilityState);
  async function hidePage(why) {
    if (!cover) {
      cover = await context.newPage();
      await cover.goto('about:blank');
    }
    await cover.bringToFront();
    for (let i = 0; i < 20 && (await visibility()) !== 'hidden'; ++i) await sleep(100);
    emulatedHide = (await visibility()) !== 'hidden';
    if (emulatedHide) {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    log(`page hidden (${why}) via ${emulatedHide ? 'emulated visibilityState (bringToFront did not hide it)' : 'a second page brought to the front'}: visibilityState=${await visibility()}`);
  }
  async function showPage() {
    await page.bringToFront();
    if (emulatedHide) {
      await page.evaluate(() => {
        delete document.visibilityState;
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      emulatedHide = false;
    }
    for (let i = 0; i < 20 && (await visibility()) !== 'visible'; ++i) await sleep(100);
    log(`page shown: visibilityState=${await visibility()}`);
  }
  const frameState = () => page.evaluate(() => ({
    frames: (window.Module && window.Module.mkwFramesPresented) || 0,
    paused: !!(window.Module && window.Module.mkwPaused),
    parks: (window.Module && window.Module.mkwParkCount) || 0,
    errorShown: !document.getElementById('error').hidden,
  }));
  async function waitFor(predicate, ms, what) {
    const end = Date.now() + ms;
    for (;;) {
      const state = await frameState();
      if (predicate(state)) return state;
      if (state.errorShown || Date.now() > end) {
        log(`gave up waiting for ${what}: ${JSON.stringify(state)}`);
        return null;
      }
      await sleep(250);
    }
  }

  if (expectedFrames) {
    // C3: start while the page is hidden and the canvas is 0x0 (display: none). The click above
    // only loads the glue; aurora_initialize runs a few seconds later, after the hide below.
    await page.evaluate(() => { document.getElementById('canvas').style.display = 'none'; });
    await hidePage('startup');
    await sleep(6000);
    const sawWait = lines.some((l) => /Waiting for the canvas before creating the surface/.test(l));
    const initializedEarly = reached.has('aurora-webgpu');
    log(`hidden start: aurora waited=${sawWait}, aurora initialized while hidden=${initializedEarly}`);
    await page.evaluate(() => { document.getElementById('canvas').style.display = ''; });
    await showPage();
    const started = await waitFor((s) => s.frames >= 60, 90000, '60 presented frames after the hidden start');
    if (started) {
      reach('frames-presented');
      if (sawWait && !initializedEarly && lines.some((l) => /Canvas is ready; creating the surface/.test(l))) {
        reach('hidden-start-waited');
      }
    }
    if (started && started.frames < expectedFrames - 120) {
      // C2: hide mid-run for a while. Frames must stop (at most the one in flight) and resume.
      await hidePage('mid-run');
      await sleep(1500);
      const before = await frameState();
      await sleep(6000);
      const after = await frameState();
      log(`while hidden: frames ${before.frames} -> ${after.frames}, parked=${after.paused}, parks=${after.parks}`);
      if (after.frames - before.frames <= 1 && after.paused && !after.errorShown) reach('hidden-parked');
      await showPage();
      const resumed = await waitFor((s) => s.frames >= after.frames + 30 && !s.paused, 60000, '30 frames after showing the page');
      if (resumed && lines.some((l) => /page visible: resumed after \d+ ms/.test(l))) reach('resumed');
    } else if (started) {
      log(`frame loop too short to test a mid-run hide (${started.frames} of ${expectedFrames} frames already presented)`);
    }
  }

  // Wait for the error overlay (expected end) or the timeout; poll so the log keeps flowing.
  const deadline = Date.now() + timeoutMs;
  let overlay = null;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      phase: document.documentElement.dataset.phase,
      errorShown: !document.getElementById('error').hidden,
      summary: document.getElementById('error-summary').textContent,
    }));
    if (state.errorShown) {
      // Give the runtime a moment to finish its exit path (onExit etc.) before reading the report.
      await new Promise((r) => setTimeout(r, 1500));
      overlay = await page.evaluate(() => ({
        summary: document.getElementById('error-summary').textContent,
        details: document.getElementById('error-details').value,
      }));
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const canvas = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    return { width: c.width, height: c.height, clientWidth: c.clientWidth, clientHeight: c.clientHeight };
  });
  log(`canvas: ${JSON.stringify(canvas)}`);

  // After the stop: the page must stay responsive (no wasm spinning on the main thread), and the
  // in-memory file system must hold the embedded /app assets and what the runtime wrote under $HOME.
  const pingStart = Date.now();
  const fsState = await page.evaluate(() => {
    const FS = window.Module && window.Module.FS;
    if (!FS) return { error: 'Module.FS is not exported' };
    const walk = (dir, depth) => {
      let out = [];
      let names = [];
      try { names = FS.readdir(dir).filter((n) => n !== '.' && n !== '..'); } catch (e) { return [`${dir}: ${e.message || e}`]; }
      for (const name of names.sort()) {
        const path = `${dir}/${name}`;
        const st = FS.stat(path);
        if (FS.isDir(st.mode)) out = out.concat(depth > 0 ? walk(path, depth - 1) : [`${path}/`]);
        else out.push(`${path} (${st.size} bytes)`);
      }
      return out;
    };
    return { app: walk('/app', 1), home: walk('/home/web_user', 4) };
  });
  const pingMs = Date.now() - pingStart;
  log(`page round trip after the stop: ${pingMs} ms`);
  if (pingMs > 2000) badLines.push(`page unresponsive after the stop (${pingMs} ms round trip)`);
  for (const [key, list] of Object.entries(fsState)) {
    for (const entry of [].concat(list)) log(`fs ${key}: ${entry}`);
  }
  if (fsState.app && fsState.app.some((e) => e.startsWith('/app/dsp_coef.bin ')) &&
      fsState.app.some((e) => e.startsWith('/app/wii_bootstrap/'))) {
    reached.add('app-assets');
    log(`MILESTONE app-assets: ${MILESTONES.find((m) => m.id === 'app-assets').what}`);
  }
  if (fsState.home && fsState.home.some((e) => /\/Config\.toml /.test(e))) {
    reached.add('home-config');
    log(`MILESTONE home-config: ${MILESTONES.find((m) => m.id === 'home-config').what}`);
  }

  if (overlay) {
    log(`error overlay summary: ${overlay.summary}`);
    for (const line of overlay.details.split('\n')) log(`  | ${line}`);
    noteLine(overlay.summary);
  } else {
    log(`TIMEOUT: no error overlay after ${timeoutMs / 1000}s`);
  }
  try {
    await page.screenshot({ path: logFile.replace(/\.log$/, '') + '.png', timeout: 5000 });
  } catch (e) { log(`screenshot failed: ${e.message}`); }

  const last = [...MILESTONES].reverse().find((m) => !m.post && reached.has(m.id));
  const missing = MILESTONES.filter((m) => !reached.has(m.id)).map((m) => m.id);
  log(`furthest milestone: ${last ? `${last.id} (${last.what})` : 'none'}`);
  if (missing.length) log(`milestones not reached: ${missing.join(', ')}`);
  for (const line of badLines) log(`problem: ${line}`);
  verdict = !missing.length && !badLines.length ? 0 : 1;
  log(verdict === 0 ? 'SMOKE PASS' : 'SMOKE FAIL');
} catch (e) {
  log(`driver error: ${e && e.stack || e}`);
}

// Echo the milestone summary to stdout for the operator.
for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
  if (/MILESTONE|furthest milestone|not reached|problem: |SMOKE (PASS|FAIL)|TIMEOUT|driver error|error overlay summary/.test(line)) console.log(line);
}
console.log(`full log: ${logFile}`);
process.exit(verdict);
