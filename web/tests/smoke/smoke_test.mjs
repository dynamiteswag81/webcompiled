// Drives the real web product (built against the synthetic translation) through startup in
// headless Chromium and reports the furthest milestone reached.
//
//   node web/tests/smoke/smoke_test.mjs URL LOGFILE [TIMEOUT_SECONDS]
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

const [url, logFile, timeoutArg] = process.argv.slice(2);
if (!url || !logFile) {
  console.error('usage: smoke_test.mjs URL LOGFILE [TIMEOUT_SECONDS]');
  process.exit(2);
}
const timeoutMs = Number(timeoutArg || 180) * 1000;
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
  { id: 'dvd-stop', what: 'translated entry point ran and DVDInit stopped cleanly: no disc data configured', re: /\[dvd\] ERROR: (No DVD root is configured|Configured DVD root is not an extracted DATA directory)/ },
  { id: 'fatal-reported', what: 'runtime fatal report reached the page error overlay', re: /DVD data is unavailable/ },
  // Checked after the stop through Module.FS (not startup order, so never the "furthest" one).
  { id: 'app-assets', post: true, what: 'embedded /app assets present (dsp_coef.bin, wii_bootstrap/)' },
  { id: 'home-config', post: true, what: 'Config.toml written under $HOME (/home/web_user)' },
];
const reached = new Set();
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
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
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
