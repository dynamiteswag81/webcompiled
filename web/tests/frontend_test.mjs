// Headless Chromium test for web/site (loading, compatibility, help, error overlay, phone width).
//
//   node web/tests/frontend_test.mjs [--shots DIR]
//
// Needs Playwright (default import path below, override with PLAYWRIGHT_MODULE) and a Chromium
// binary (CHROMIUM_PATH). Builds a throw-away site dir from web/site + web/tests/fixtures (stub
// glue and a generated dummy .wasm), serves it with web/serve.py and drives the page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const pw = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
  : '/opt/node-tools/node_modules/playwright/index.mjs');
const { chromium } = pw.default ?? pw;

const shotsDir = (() => {
  const i = process.argv.indexOf('--shots');
  return i > 0 ? path.resolve(process.argv[i + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'wc-shots-'));
})();
fs.mkdirSync(shotsDir, { recursive: true });

// ---- throw-away site -------------------------------------------------------------------------
const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-site-'));
fs.cpSync(path.join(webDir, 'site'), siteDir, { recursive: true });
fs.copyFileSync(path.join(here, 'fixtures', 'WiiCompiled.js'), path.join(siteDir, 'WiiCompiled.js'));
// Second product (Retro Rewind): the same stub under another name. products.json is NOT in the site
// dir (the default scenarios run without it); the product scenarios inject it with page.route().
fs.writeFileSync(path.join(siteDir, 'RetroRewind.js'),
  "window.__stubGlueName = 'RetroRewind.js';\n" + fs.readFileSync(path.join(here, 'fixtures', 'WiiCompiled.js'), 'utf8'));
{ // minimal valid wasm module padded with a ~3 MiB custom section so download progress is visible
  const name = Buffer.from('pad');
  const payload = Buffer.alloc(3 * 1024 * 1024, 0x2a);
  const sectionLen = 1 + name.length + payload.length;
  const leb = []; let n = sectionLen;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; leb.push(b); } while (n);
  fs.writeFileSync(path.join(siteDir, 'WiiCompiled.wasm'), Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00]), Buffer.from(leb),
    Buffer.from([name.length]), name, payload]));
  fs.copyFileSync(path.join(siteDir, 'WiiCompiled.wasm'), path.join(siteDir, 'RetroRewind.wasm'));
}

// ---- server ---------------------------------------------------------------------------------
const port = 18000 + Math.floor(Math.random() * 2000);
const server = spawn('python3', [path.join(webDir, 'serve.py'), '--dir', siteDir, '--port', String(port), '-q'], { stdio: 'inherit' });
const base = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}

// ---- assertions -----------------------------------------------------------------------------
let failures = 0;
function check(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failures++;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
    '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--no-sandbox'],
});

async function newPage(opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 720 },
    hasTouch: !!opts.touch,
    isMobile: !!opts.touch,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', () => {}); // expected in the error scenarios
  if (opts.init) await page.addInitScript(opts.init);
  return page;
}
const phase = (page) => page.evaluate(() => document.documentElement.dataset.phase);
const waitPhase = (page, p, timeout = 20000) =>
  page.waitForFunction((x) => document.documentElement.dataset.phase === x, p, { timeout });
const noHScroll = (page) => page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
const shot = (page, name) => page.screenshot({ path: path.join(shotsDir, name + '.png') });

try {
  // 1. Happy path, desktop, with a paced wasm download so the progress bar is observable ------------
  {
    const page = await newPage({
      init: () => {
        const realFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : input.url;
          const resp = await realFetch(input, init);
          if (!url.endsWith('.wasm')) return resp;
          const total = Number(resp.headers.get('Content-Length'));
          const reader = resp.body.getReader();
          const stream = new ReadableStream({
            async pull(ctrl) {
              const { done, value } = await reader.read();
              if (done) return ctrl.close();
              // dribble each chunk in 256 KiB pieces
              for (let o = 0; o < value.length; o += 262144) {
                ctrl.enqueue(value.subarray(o, o + 262144));
                await new Promise((r) => setTimeout(r, 250));
              }
            },
          });
          window.__wasmTotal = total;
          return new Response(stream, { status: 200, headers: { 'Content-Length': String(total) } });
        };
      },
    });
    await page.goto(base + '?stub=slow');
    await waitPhase(page, 'downloading');
    await page.waitForFunction(() => {
      const v = Number(document.getElementById('progress').getAttribute('aria-valuenow'));
      return v >= 25 && v < 100;
    }, null, { timeout: 15000 });
    check(true, 'loading screen shows partial download progress');
    check(/Downloading WiiCompiled\.wasm: [\d.]+ MiB \/ [\d.]+ MiB/.test(await page.textContent('#status')), 'status text reports MiB downloaded / total');
    await shot(page, '1-loading-download');
    await waitPhase(page, 'ready');
    check(await page.isVisible('#btn-start'), 'click-to-start button appears after download');
    check(await page.evaluate(() => !window.Module.calledRun && typeof WebAssembly.Suspending === 'function'), 'glue not started before the click');
    check(await page.evaluate(() => !document.scripts.length || ![...document.scripts].some((s) => /WiiCompiled\.js/.test(s.src))), 'glue script not loaded before the click');
    await shot(page, '2-ready-click-to-start');
    await page.click('#btn-start');
    await waitPhase(page, 'starting');
    await page.waitForFunction(() => /Downloading data/.test(document.getElementById('status').textContent), null, { timeout: 5000 });
    check(true, 'Module.setStatus text is displayed while starting');
    await shot(page, '3-starting');
    await waitPhase(page, 'running');
    check(!(await page.isVisible('#loader')), 'loader hidden once the runtime is initialized');
    check(await page.isVisible('#toolbar'), 'toolbar visible while running');
    // The toolbar auto-hides when idle so it does not cover the in-game FPS counter (top right)
    // and comes back on pointer movement.
    const toolbarIdle = () => page.evaluate(() => document.getElementById('toolbar').classList.contains('idle'));
    await page.mouse.move(300, 300);
    check(!(await toolbarIdle()), 'toolbar shown right after pointer movement');
    await page.waitForFunction(() => document.getElementById('toolbar').classList.contains('idle'), null, { timeout: 8000 });
    await page.waitForFunction(() => getComputedStyle(document.getElementById('toolbar')).opacity === '0', null, { timeout: 3000 })
      .then(() => check(true, 'idle toolbar is faded out'), () => check(false, 'idle toolbar is faded out'));
    await page.mouse.move(320, 310);
    check(!(await toolbarIdle()), 'toolbar returns on pointer movement');
    const px = await page.evaluate(() => {
      const c = document.getElementById('canvas');
      const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    check(px.some((v) => v > 0), 'stub drew into #canvas');
    check(await page.evaluate(() => {
      const r = document.getElementById('canvas').getBoundingClientRect();
      return Math.abs(r.width - innerWidth) < 1 && Math.abs(r.height - innerHeight) < 1;
    }), 'canvas fills the window');
    await shot(page, '4-running');

    // help overlay
    await page.keyboard.press('Shift+?');
    check(await page.isVisible('#help'), '? opens the controls overlay');
    check(!(await page.textContent('#help')).includes('Placeholder'), 'help no longer calls the mapping a placeholder');
    const kbRows = await page.$$eval('#keyboard-rows tr', (rows) => rows.map((r) => [...r.cells].map((c) => c.textContent.trim())));
    const kbRow = (gc) => kbRows.find((r) => r[1] === gc) || [];
    check(kbRow('A')[0] === 'X' && /Accelerate/.test(kbRow('A')[2]), `keyboard table: X = A (accelerate) (${JSON.stringify(kbRow('A'))})`);
    check(kbRow('B')[0] === 'Z' && kbRow('R')[0] === 'Shift' && kbRow('L')[0] === 'Space' && kbRow('Start')[0] === 'Enter',
      'keyboard table: Z = B, Shift = R, Space = L, Enter = Start');
    check(kbRow('X')[0] === 'C' && kbRow('Y')[0] === 'V' && kbRow('Z')[0] === 'Q', 'keyboard table: C = X, V = Y, Q = Z');
    check(kbRow('Control stick')[0] === '→ ← ↑ ↓' && kbRow('C-stick')[0] === 'I J K L', 'keyboard table: arrows = stick, IJKL = C-stick');
    check(kbRows.length === 11 && await page.evaluate(() => window.WiiCompiledInput.KEYBOARD_LAYOUT.length === 22),
      `keyboard table generated from the layout (${kbRows.length} rows)`);
    const padRows = await page.$$eval('#pad-layout-rows tr', (rows) => rows.map((r) => [...r.cells].map((c) => c.textContent.trim())));
    check(padRows.some((r) => r.join('|') === 'A|A|Cross|B') && padRows.some((r) => r.join('|') === 'R|RT|R2|ZR'),
      'gamepad table lists the Xbox / PlayStation / Switch layouts');
    check((await page.textContent('#help')).toLowerCase().includes('gamepad api'), 'help mentions the Gamepad API');
    check((await page.textContent('#gamepad-status')).includes('No gamepad'), 'no gamepad reported without one');
    check((await page.textContent('#help')).includes('F10'), 'help explains F10 rebinding');
    await shot(page, '5-help');
    await page.keyboard.press('Escape');
    check(!(await page.isVisible('#help')), 'Escape closes the controls overlay');
    await page.keyboard.press('h');
    check(await page.isVisible('#help'), 'H opens the controls overlay');
    await page.keyboard.press('h');
    check(!(await page.isVisible('#help')), 'H closes the controls overlay');
    await page.click('#btn-help');
    check(await page.isVisible('#help'), 'Controls button opens the overlay');
    await page.click('#input-debug-toggle');
    check(await page.isVisible('#input-debug'), 'debug toggle shows the input debug view');
    await page.click('#btn-help-close');
    check(!(await page.isVisible('#help')), 'Close button closes the overlay');
    check(await page.evaluate(() => document.activeElement === document.getElementById('canvas')),
      'closing the panel returns focus to the game, not to the toolbar');
    await page.waitForFunction(() => /No gamepad/.test(document.getElementById('debug-raw').textContent) &&
      /not read input/.test(document.getElementById('debug-game').textContent), null, { timeout: 3000 });
    check(true, 'debug view shows browser and game columns while the game runs');
    await shot(page, '5b-input-debug');
    await page.click('#btn-debug-close');
    check(!(await page.isVisible('#input-debug')), 'debug view closes');
    const f10 = await page.evaluate(() => new Promise((resolve) => {
      const seen = [];
      const listener = (e) => seen.push(e.type + ':' + e.code);
      window.addEventListener('keydown', listener);
      window.addEventListener('keyup', listener);
      document.getElementById('btn-settings').click();
      setTimeout(() => { window.removeEventListener('keydown', listener); window.removeEventListener('keyup', listener); resolve(seen); }, 50);
    }));
    check(f10.join(',') === 'keydown:F10,keyup:F10', `Settings button sends F10 (${f10.join(',')})`);

    // fullscreen
    await page.click('#btn-fullscreen');
    await page.waitForTimeout(500);
    const fs1 = await page.evaluate(() => !!document.fullscreenElement);
    console.log(`INFO fullscreen after click: ${fs1}`);
    check(fs1, 'Fullscreen button enters fullscreen');
    if (fs1) { await page.click('#btn-fullscreen'); await page.waitForTimeout(300); }
    check(!(await page.evaluate(() => !!document.fullscreenElement)), 'Fullscreen button exits fullscreen');

    check(await page.evaluate(() => typeof Module.onAbort === 'function' && typeof Module.locateFile === 'function'
      && typeof Module.setStatus === 'function' && typeof Module.monitorRunDependencies === 'function'), 'Module hooks defined');
    check(await page.evaluate(() => Module.locateFile('x.data', '/p/') === '/p/x.data' && Module.locateFile('WiiCompiled.wasm', '/p/') === 'WiiCompiled.wasm'), 'locateFile behaves');
    await page.context().close();
  }

  // 2. Error scenarios --------------------------------------------------------------------------
  for (const [mode, needle] of [['abort', 'stub abort'], ['throw', 'stub window error'], ['reject', 'stub unhandled rejection']]) {
    const page = await newPage();
    await page.goto(`${base}?stub=${mode}`);
    await waitPhase(page, 'ready');
    await page.click('#btn-start');
    await page.waitForFunction(() => !document.getElementById('error').hidden, null, { timeout: 15000 });
    check((await page.textContent('#error-summary')).includes(needle), `${mode}: error overlay shows the error`);
    const details = await page.inputValue('#error-details');
    check(details.includes('last ') && details.includes('stub glue loaded'), `${mode}: details contain captured console lines`);
    check(details.includes('stub warning line') && details.includes(' WARN '), `${mode}: console.warn captured with level`);
    check(details.includes('userAgent:') && details.includes('gpu:'), `${mode}: details contain environment info`);
    await page.click('#btn-copy');
    await page.waitForFunction(() => document.getElementById('copy-result').textContent !== '');
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    check(clip === details, `${mode}: "Copy details" puts the report on the clipboard`);
    if (mode === 'abort') await shot(page, '6-error');
    await page.context().close();
  }

  // 3. Console buffer is capped ------------------------------------------------------------------
  {
    const page = await newPage();
    await page.goto(base);
    await waitPhase(page, 'ready');
    await page.evaluate(() => { for (let i = 0; i < 1000; i++) console.log('spam ' + i); window.WiiCompiledUI.showError('manual', 'trigger'); });
    const details = await page.inputValue('#error-details');
    const tail = details.slice(details.indexOf('--- last '));
    const lines = tail.split('\n').filter((l) => /^\[\s*[\d.]+\] /.test(l));
    check(lines.length === 200 && details.includes('spam 999') && !details.includes('spam 100\n'), `console buffer capped at 200 lines (got ${lines.length})`);
    await page.context().close();
  }

  // 3b. Error retention: boot noise must not push out the first occurrence of each distinct error ---
  {
    const page = await newPage();
    await page.goto(base);
    await waitPhase(page, 'ready');
    await page.evaluate(() => {
      console.error('[dvd/web] mount failed: manifest HTTP 404 for disc-manifest.json');   // root cause, very early
      console.warn('benign warning line');
      for (let i = 0; i < 3; i++) console.error('read failed: offset=0x' + (4096 + i).toString(16) + ' length=' + (100 + i) + ' code=-2');
      console.log('fatal-looking info line: could not open save 7');
      console.log('fatal-looking info line: could not open save 8');
      for (let i = 0; i < 1000; i++) console.log('boot noise ' + i);
      window.WiiCompiledUI.showError('manual', 'trigger');
    });
    const details = await page.inputValue('#error-details');
    const [head, tail] = details.split('--- last ');
    check(head.includes('first occurrence of each distinct error-like console line'), 'report has a "first occurrence" section');
    check(head.includes('mount failed: manifest HTTP # for disc-manifest.json') === false && head.includes('mount failed: manifest HTTP 404 for disc-manifest.json'),
      'the early root-cause error survives 1000 noise lines');
    check(!tail.includes('mount failed') && tail.includes('boot noise 999'), 'the root cause is no longer in the last-200 tail (so it only survives via the first-error section)');
    check((head.match(/read failed: offset=/g) || []).length === 1 && /read failed: offset=0x1000 length=100 code=-2 +\(x3\)/.test(head),
      'errors differing only in numbers are deduplicated with a count');
    check((head.match(/could not open save/g) || []).length === 1, 'error-like text at LOG level is kept once (numbers stripped)');
    check(!head.includes('benign warning line'), 'ordinary warnings are not treated as errors');
    await page.context().close();

    const page2 = await newPage();
    await page2.goto(base);
    await waitPhase(page2, 'ready');
    await page2.evaluate(() => {
      const word = (i) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + ((i / 26) | 0) % 26) + String.fromCharCode(97 + ((i / 676) | 0));
      for (let i = 0; i < 150; i++) console.error('distinct failure kind ' + word(i));
      window.WiiCompiledUI.showError('manual', 'trigger');
    });
    const d2 = await page2.inputValue('#error-details');
    const head2 = d2.split('--- last ')[0];
    const kinds = (head2.match(/distinct failure kind /g) || []).length;
    check(kinds === 100 && /51 more kinds not kept/.test(head2), `distinct error kinds are capped at 100 (kept ${kinds}) and the report counts the rest`);
    await page2.context().close();
  }

  // 4. Compatibility failures -----------------------------------------------------------------
  for (const [label, init, expect] of [
    ['no WebGPU', () => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }), 'WebGPU'],
    ['no adapter', () => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => ({ requestAdapter: async () => null }), configurable: true }), 'WebGPU'],
    ['no JSPI', () => { delete WebAssembly.Suspending; }, 'JSPI'],
  ]) {
    const page = await newPage({ init });
    await page.goto(base);
    await waitPhase(page, 'incompatible');
    const text = await page.textContent('#compat-error');
    check(text.includes('Chrome') && text.includes('Edge') && text.includes('137') && text.includes(expect), `${label}: message names Chrome/Edge 137+ and the missing feature`);
    check(!(await page.isVisible('#btn-start')) && !(await page.isVisible('#progress')), `${label}: no start button or progress bar`);
    check(await page.evaluate(() => ![...document.scripts].some((s) => /WiiCompiled\.js/.test(s.src))), `${label}: game not loaded`);
    if (label === 'no WebGPU') await shot(page, '7-incompatible');
    await page.context().close();
  }

  // 5. Phone width: no horizontal scroll in any state ---------------------------------------------
  {
    const page = await newPage({ viewport: { width: 360, height: 640 } });
    await page.goto(base);
    await waitPhase(page, 'ready');
    check(await noHScroll(page), 'phone: no horizontal scroll (ready)');
    await shot(page, '8-phone-ready');
    await page.click('#btn-start');
    await waitPhase(page, 'running');
    check(await noHScroll(page), 'phone: no horizontal scroll (running)');
    await page.click('#btn-help');
    check(await noHScroll(page), 'phone: no horizontal scroll (help)');
    check(await page.evaluate(() => {
      const r = document.querySelector('#help .panel').getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    }), 'phone: help panel fits the viewport width');
    await shot(page, '9-phone-help');
    await page.click('#input-debug-toggle');
    await page.keyboard.press('Escape');
    check(await page.isVisible('#input-debug') && await noHScroll(page), 'phone: no horizontal scroll (input debug view)');
    check(await page.evaluate(() => {
      const r = document.getElementById('input-debug').getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    }), 'phone: input debug view fits the viewport width');
    await page.click('#btn-debug-close');
    await page.evaluate(() => window.WiiCompiledUI.showError('manual', 'x'.repeat(300)));
    check(await noHScroll(page), 'phone: no horizontal scroll (error)');
    await shot(page, '10-phone-error');
    await page.context().close();
  }

  // 5b. Touch controls (touch.js): real multi-touch through CDP, state as the runtime receives it ---
  {
    // Desktop: never shown without a touch.
    const desk = await newPage();
    await desk.goto(base);
    await waitPhase(desk, 'ready');
    await desk.click('#btn-start');
    await waitPhase(desk, 'running');
    check(await desk.evaluate(() => document.getElementById('touch').hidden), 'touch: hidden on a desktop that was not touched');
    check(await desk.evaluate(() => document.getElementById('btn-touch').hidden), 'touch: no Touch toolbar button without a touch screen');
    check(await desk.evaluate(() => {
      const heads = [...document.querySelectorAll('#help h3')].map((h) => h.textContent);
      return heads[0] === 'Keyboard (player 1)' && heads.indexOf('Touch screens') === heads.indexOf('Rebinding') - 1;
    }), 'touch: on a desktop the Controls panel keeps the keyboard first, touch before Rebinding');
    await desk.context().close();

    for (const [label, viewport] of [['landscape', { width: 844, height: 390 }], ['portrait', { width: 390, height: 844 }]]) {
      const page = await newPage({ viewport, touch: true });
      await page.goto(base);
      await waitPhase(page, 'ready');
      await page.tap('#btn-start');
      await waitPhase(page, 'running');
      // Stand-in for library_mkw_input.js: record what the page hands the runtime.
      await page.evaluate(() => {
        window.__touch = [];
        window.Module.mkwInput = {
          setTouch: (t) => { window.__touch.push(t); return true; },
          ports: () => [{ motor: 0, controller: false, touch: true }],
          reads: () => 1,
          description: () => null,
          buttonNames: () => [],
        };
        window.Module.onMkwInputReady();
      });
      const last = () => page.evaluate(() => window.__touch[window.__touch.length - 1] || null);
      const center = (sel) => page.evaluate((s) => {
        const r = document.querySelector(s).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, sel);
      check(await page.evaluate(() => !document.getElementById('touch').hidden), `touch (${label}): shown after starting from a touch screen`);
      check((await last())?.active === true, `touch (${label}): the runtime is told the controls are active`);
      check(await noHScroll(page), `touch (${label}): no horizontal scroll`);
      check(await page.evaluate(() => [...document.querySelectorAll('.touch-btn')].every((e) => {
        const r = e.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      })), `touch (${label}): every button is on screen`);
      check(await page.evaluate(() => {
        const rs = [...document.querySelectorAll('.touch-btn, .touch-stick')].map((e) => e.getBoundingClientRect());
        return rs.every((a, i) => rs.every((b, j) => i === j || a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
      }), `touch (${label}): buttons and the stick do not overlap`);
      await page.evaluate(() => window.WiiCompiledUI.showToolbar());
      check(await page.evaluate(() => {
        const t = document.getElementById('toolbar').getBoundingClientRect();
        return [...document.querySelectorAll('.touch-btn, .touch-stick')].every((e) => {
          const r = e.getBoundingClientRect();
          return t.right <= r.left || r.right <= t.left || t.bottom <= r.top || r.bottom <= t.top;
        });
      }), `touch (${label}): the page toolbar does not cover any control`);
      await shot(page, `10-touch-${label}`);

      const cdp = await page.context().newCDPSession(page);
      const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
      const zone = await page.evaluate(() => {
        const r = document.querySelector('.touch-zone').getBoundingClientRect();
        return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.6 };
      });
      const a = await center('.touch-a');
      const drift = await center('.touch-r');

      await touch('touchStart', [{ x: zone.x, y: zone.y, id: 1 }]);
      await touch('touchMove', [{ x: zone.x + 200, y: zone.y, id: 1 }]);
      let t = await last();
      check(t.stickX === 127 && t.stickY === 0, `touch (${label}): dragging right is full right on the stick (${t.stickX}, ${t.stickY})`);
      await touch('touchMove', [{ x: zone.x + 10, y: zone.y - 200, id: 1 }]);
      t = await last();
      check(t.stickY > 120 && Math.abs(t.stickX) < 15, `touch (${label}): dragging up is stick up (${t.stickX}, ${t.stickY})`);
      await touch('touchMove', [{ x: zone.x + 2, y: zone.y + 2, id: 1 }]);
      t = await last();
      check(t.stickX === 0 && t.stickY === 0, `touch (${label}): small movements stay in the dead zone`);

      // Second finger: A while steering, then slide onto Drift.
      await touch('touchMove', [{ x: zone.x - 200, y: zone.y, id: 1 }]);
      await touch('touchStart', [{ x: zone.x - 200, y: zone.y, id: 1 }, { x: a.x, y: a.y, id: 2 }]);
      t = await last();
      check(t.button === 0x100 && t.stickX === -127, `touch (${label}): A and full left together (button ${t.button}, stick ${t.stickX})`);
      await touch('touchMove', [{ x: zone.x - 200, y: zone.y, id: 1 }, { x: drift.x, y: drift.y, id: 2 }]);
      t = await last();
      check(t.button === 0x20 && t.triggerR === 255, `touch (${label}): sliding from A onto Drift holds R with the analog trigger (button ${t.button})`);
      await touch('touchEnd', []);
      t = await last();
      check(t.button === 0 && t.stickX === 0 && t.stickY === 0 && t.active, `touch (${label}): lifting every finger releases everything`);

      // Auto A keeps A held with no finger on it; a tap on A meanwhile does not let go; tap Auto A again to stop.
      const latch = await center('.touch-latch');
      await touch('touchStart', [{ x: latch.x, y: latch.y, id: 3 }]);
      await touch('touchEnd', []);
      t = await last();
      check(t.button === 0x100 && await page.evaluate(() => document.querySelector('.touch-a').classList.contains('latched')),
        `touch (${label}): Auto A keeps accelerating`);
      await touch('touchStart', [{ x: a.x, y: a.y, id: 4 }, { x: zone.x, y: zone.y, id: 9 }]);
      await touch('touchEnd', []);
      check((await last()).button === 0x100, `touch (${label}): pressing A meanwhile keeps it held`);
      await touch('touchStart', [{ x: latch.x, y: latch.y, id: 4 }]);
      await touch('touchEnd', []);
      t = await last();
      check(t.button === 0, `touch (${label}): tapping Auto A again lets go`);

      // Touches on the controls do not pop up the page toolbar.
      await page.evaluate(() => document.getElementById('toolbar').classList.add('idle'));
      await touch('touchStart', [{ x: a.x, y: a.y, id: 5 }]);
      await touch('touchEnd', []);
      check(await page.evaluate(() => document.getElementById('toolbar').classList.contains('idle')), `touch (${label}): pressing a control leaves the toolbar hidden`);

      if (label === 'landscape') {
        // Auto mode: the keyboard takes over, a touch brings them back; the toolbar toggle forces them.
        await page.keyboard.press('KeyX');
        check(await page.evaluate(() => document.getElementById('touch').hidden) && (await last()).active === false,
          'touch: hidden again (and inactive in the runtime) once the keyboard is used');
        await touch('touchStart', [{ x: 300, y: 100, id: 6 }]);
        await touch('touchEnd', []);
        check(await page.evaluate(() => !document.getElementById('touch').hidden), 'touch: a touch brings them back');
        await page.evaluate(() => document.getElementById('btn-touch').click());
        check(await page.evaluate(() => document.getElementById('touch').hidden && JSON.parse(localStorage.getItem('wiicompiled.touch')).show === 'never'),
          'touch: the toolbar button turns them off and remembers it');
        await page.evaluate(() => document.getElementById('btn-touch').click());
        check(await page.evaluate(() => !document.getElementById('touch').hidden && document.getElementById('touch-show').value === 'always'),
          'touch: and on again (the Controls panel shows the same setting)');
        // Size setting scales the controls.
        const before = await page.evaluate(() => document.querySelector('.touch-a').getBoundingClientRect().width);
        await page.evaluate(() => { const r = document.getElementById('touch-size'); r.value = '130'; r.dispatchEvent(new Event('input')); });
        const after = await page.evaluate(() => document.querySelector('.touch-a').getBoundingClientRect().width);
        check(after > before * 1.2, `touch: the Size setting scales the buttons (${before} -> ${after})`);
        // ☰ brings the faded-out toolbar back; while faded it takes no touches.
        await page.evaluate(() => document.getElementById('toolbar').classList.add('idle'));
        check(await page.evaluate(() => getComputedStyle(document.getElementById('toolbar')).pointerEvents === 'none'),
          'touch: the faded-out toolbar takes no touches');
        const menu = await center('.touch-menu');
        await touch('touchStart', [{ x: menu.x, y: menu.y, id: 7 }]);
        await touch('touchEnd', []);
        check(await page.evaluate(() => !document.getElementById('toolbar').classList.contains('idle')), 'touch: ☰ brings the toolbar back');
        await page.tap('#btn-help');
        check(await page.evaluate(() => !document.getElementById('help').hidden), 'touch: and its Controls button opens the panel');
        check(await page.evaluate(() => {
          const heads = [...document.querySelectorAll('#help h3')].map((h) => h.textContent);
          return heads[0] === 'Touch screens';
        }), 'touch: the Controls panel leads with the touch section');
        await shot(page, '11-touch-help');
        check(await page.evaluate(() => document.getElementById('error').hidden), 'touch: no error overlay along the way');
      }
      await page.context().close();
    }
  }

  // 6. Product selection (products.json) ---------------------------------------------------------
  const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
  const withProducts = async (page, body) => {
    await page.route('**/products.json', (route) => body === null
      ? route.fulfill({ status: 404, body: 'nope' })
      : route.fulfill({ status: 200, contentType: 'application/json', body }));
  };
  const requested = (page) => {
    const urls = [];
    page.on('request', (r) => urls.push(new URL(r.url()).pathname.replace(/^\//, '')));
    return urls;
  };
  const productSeen = (page) => page.evaluate(() => JSON.parse(window.__stubProduct));
  const startAndRun = async (page) => {
    await waitPhase(page, 'ready');
    await page.click('#btn-start');
    await waitPhase(page, 'running');
  };
  {
    // 6a. two products: choice screen, nothing downloaded until a choice is made
    const page = await newPage();
    await withProducts(page, fixture('products.two.json'));
    const urls = requested(page);
    await page.goto(base);
    await waitPhase(page, 'choosing');
    const labels = await page.$$eval('#product-list .product', (b) => b.map((x) => x.textContent));
    check(labels.length === 2 && labels[0].startsWith('Mario Kart Wii') && labels[1].startsWith('Retro Rewind'), `two products: choice shows both (${JSON.stringify(labels)})`);
    check(!(await page.isVisible('#btn-start')) && !(await page.isVisible('#progress')), 'two products: no start button or progress before a choice');
    check(!urls.some((u) => u.endsWith('.wasm')), 'two products: no wasm downloaded before a choice');
    await shot(page, '11-product-choice');
    await page.click('#product-list .product[data-product="RetroRewind"]');
    await startAndRun(page);
    check(urls.includes('RetroRewind.wasm') && !urls.includes('WiiCompiled.wasm'), 'Retro Rewind choice downloads RetroRewind.wasm only');
    check(urls.includes('RetroRewind.js') && !urls.includes('WiiCompiled.js'), 'Retro Rewind choice loads RetroRewind.js only');
    check(await page.evaluate(() => window.__stubGlue) === 'RetroRewind.js', 'the Retro Rewind glue ran');
    const prod = await productSeen(page);
    check(prod && prod.id === 'RetroRewind' && prod.modRoot === 'mods/RetroRewind6', `Module.mkwProduct = ${JSON.stringify(prod)} when the glue starts`);
    check(await page.evaluate(() => Module.mkwProduct.modManifest) === 'mods/RetroRewind6-manifest.json', 'Module.mkwProduct.modManifest names the mod manifest');
    check(await page.evaluate(() => localStorage.getItem('wiicompiled.product')) === 'RetroRewind', 'choice is remembered in localStorage');
    await page.context().close();
  }
  {
    // 6b. a remembered choice is highlighted and focused; "Choose a different game" returns to the list
    const page = await newPage();
    await page.addInitScript(() => { try { if (!localStorage.getItem('seeded')) { localStorage.setItem('seeded', '1'); localStorage.setItem('wiicompiled.product', 'RetroRewind'); } } catch (_) {} });
    await withProducts(page, fixture('products.two.json'));
    await page.goto(base);
    await waitPhase(page, 'choosing');
    check(await page.evaluate(() => document.activeElement && document.activeElement.dataset.product) === 'RetroRewind', 'remembered product is focused');
    check(await page.evaluate(() => document.querySelector('.product.last').dataset.product) === 'RetroRewind', 'remembered product is highlighted');
    await page.click('#product-list .product[data-product="WiiCompiled"]');
    await waitPhase(page, 'ready');
    const prodBase = await (async () => { await page.click('#btn-start'); await waitPhase(page, 'running'); return productSeen(page); })();
    check(prodBase.id === 'WiiCompiled' && prodBase.modRoot === null, `base choice: Module.mkwProduct = ${JSON.stringify(prodBase)}`);
    check(await page.evaluate(() => window.__stubGlue) === 'WiiCompiled.js', 'the base glue ran for the base choice');
    await page.context().close();

    const page2 = await newPage();
    await withProducts(page2, fixture('products.two.json'));
    await page2.goto(base + '?product=RetroRewind&stub=ok');
    await waitPhase(page2, 'ready');
    check(await page2.isVisible('#btn-change-product'), 'deep link: "Choose a different game" is offered');
    await page2.click('#btn-change-product');
    await waitPhase(page2, 'choosing');
    check(!page2.url().includes('product='), 'changing game drops ?product= from the URL');
    await page2.context().close();
  }
  {
    // 6c. deep link skips the choice (case-insensitive); unknown ids fall back to the choice
    const page = await newPage();
    await withProducts(page, fixture('products.two.json'));
    const urls = requested(page);
    await page.goto(base + '?product=retrorewind');
    await startAndRun(page);
    const prod = await productSeen(page);
    check(prod.id === 'RetroRewind' && !urls.includes('WiiCompiled.wasm'), '?product=RetroRewind skips the choice screen');
    await page.context().close();

    const page2 = await newPage();
    await withProducts(page2, fixture('products.two.json'));
    await page2.goto(base + '?product=Nope');
    await waitPhase(page2, 'choosing');
    check(true, '?product=<unknown> falls back to the choice screen');
    await page2.context().close();
  }
  {
    // 6d. one product, a 404, malformed JSON and unsafe entries all behave like the single-product site
    for (const [label, body] of [['one product', fixture('products.one.json')], ['no products.json', null], ['malformed json', '{nope'],
      ['unsafe entries', '[{"id":"x","glue":"../evil.js"},{"id":"y","glue":"/abs.js"},{"id":"z","glue":"a.txt"}]']]) {
      const page = await newPage();
      await withProducts(page, body);
      const urls = requested(page);
      await page.goto(base);
      await waitPhase(page, 'ready');
      check(!(await page.isVisible('#product-area')) && !(await page.isVisible('#btn-change-product')), `${label}: no choice screen`);
      await page.click('#btn-start');
      await waitPhase(page, 'running');
      const prod = await productSeen(page);
      check(urls.includes('WiiCompiled.wasm') && prod && prod.id === 'WiiCompiled' && prod.modRoot === null, `${label}: plain base game starts (${JSON.stringify(prod)})`);
      await page.context().close();
    }
  }
  {
    // 6e. blocked localStorage must not break the page; phone width has no horizontal scroll
    const page = await newPage({
      viewport: { width: 360, height: 640 },
      init: () => {
        const boom = () => { throw new DOMException('blocked', 'SecurityError'); };
        Storage.prototype.getItem = boom; Storage.prototype.setItem = boom;
      },
    });
    await withProducts(page, fixture('products.two.json'));
    await page.goto(base);
    await waitPhase(page, 'choosing');
    check(await noHScroll(page), 'phone: no horizontal scroll (product choice)');
    check(await page.evaluate(() => [...document.querySelectorAll('.product')].every((b) => {
      const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height >= 44;
    })), 'phone: product buttons fit the width and are tap-sized');
    await shot(page, '12-phone-product-choice');
    await page.click('#product-list .product[data-product="RetroRewind"]');
    await startAndRun(page);
    check((await productSeen(page)).id === 'RetroRewind', 'selection works with localStorage blocked');
    await page.context().close();
  }

  // 7. Save-store banner (another tab owns the saves) -------------------------------------------------
  {
    const page = await newPage({ viewport: { width: 360, height: 640 } });
    await page.goto(base + '?saves=readonly');
    await startAndRun(page);
    check(await page.isVisible('#save-banner'), 'read-only save store: banner shown');
    check((await page.textContent('#save-banner')).includes("This game is open in another tab; progress here won't be saved"), 'banner text says progress will not be saved');
    check(await noHScroll(page), 'phone: no horizontal scroll with the save banner');
    await shot(page, '13-save-banner');
    await page.click('#save-banner button:has-text("Dismiss")');
    check(!(await page.isVisible('#save-banner')), 'banner can be dismissed');
    await page.context().close();
    const page2 = await newPage();
    await page2.goto(base);
    await startAndRun(page2);
    check((await page2.locator('#save-banner').count()) === 0, 'no banner when this tab owns the saves');
    await page2.context().close();
  }

  // 8. Content-hashed, precompressed wasm (products.json "wasm" + size fields) -----------------------------
  {
    const hashedSite = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hashed-'));
    fs.cpSync(siteDir, hashedSite, { recursive: true });
    fs.writeFileSync(path.join(hashedSite, 'products.json'), JSON.stringify([
      { id: 'WiiCompiled', title: 'Mario Kart Wii', glue: 'WiiCompiled.js' }]));
    const tool = spawnSync('python3', [path.join(webDir, 'tools', 'precompress_dist.py'), hashedSite, '--no-brotli', '-q'], { encoding: 'utf8' });
    check(tool.status === 0, 'precompress_dist.py runs on the test site ' + (tool.stderr || ''));
    const prods = JSON.parse(fs.readFileSync(path.join(hashedSite, 'products.json'), 'utf8'));
    const wasmName = prods[0].wasm;
    check(/^WiiCompiled\.[0-9a-f]{8}\.wasm$/.test(wasmName) && prods[0].glue === 'WiiCompiled.js', `products.json names a hashed wasm and keeps the glue (${wasmName})`);
    check(prods[0].wasmSize === fs.statSync(path.join(hashedSite, wasmName)).size && prods[0].wasmGzSize > 0 && prods[0].wasmGzSize < prods[0].wasmSize, 'products.json records raw and gzip sizes');
    check(!fs.existsSync(path.join(hashedSite, 'WiiCompiled.wasm')), 'the unhashed wasm is gone from the site');

    const port2 = port + 2100;
    const server2 = spawn('python3', [path.join(webDir, 'serve.py'), '--dir', hashedSite, '--port', String(port2), '-q'], { stdio: 'inherit' });
    const base2 = `http://127.0.0.1:${port2}/`;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(base2)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      page.on('pageerror', () => {});
      const seen = [];
      page.on('response', (r) => { const u = new URL(r.url()).pathname; if (u.endsWith('.wasm') || u.endsWith('.json')) seen.push({ u, h: r.headers(), status: r.status() }); });
      const percents = [];
      await page.exposeFunction('__pct', (v) => percents.push(v));
      await page.addInitScript(() => {
        new MutationObserver(() => {
          const v = document.getElementById('progress')?.getAttribute('aria-valuenow');
          if (v != null) window.__pct(Number(v));
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ['aria-valuenow'] });
      });
      await page.goto(base2);
      await waitPhase(page, 'ready');
      const w = seen.find((r) => r.u.endsWith('.wasm'));
      check(w && w.u === '/' + wasmName, `the page fetched the hashed wasm (${w && w.u})`);
      check(w && w.h['content-encoding'] === 'gzip' && w.h['vary'] === 'Accept-Encoding', 'wasm arrived gzip-encoded with Vary');
      check(w && w.h['cache-control'] === 'public, max-age=31536000, immutable', 'hashed wasm is cached immutably');
      check(w && Number(w.h['content-length']) === prods[0].wasmGzSize, 'Content-Length is the compressed size');
      check(seen.every((r) => !r.u.endsWith('/WiiCompiled.wasm')), 'the unhashed wasm name is never requested');
      const pj = seen.find((r) => r.u === '/products.json');
      check(pj && pj.h['cache-control'] === 'no-cache', 'products.json is revalidated every time');
      check(percents.length > 0 && percents.every((v) => v >= 0 && v <= 100), `progress stays within 0..100 with compressed transfer (${percents.length} samples, max ${Math.max(...percents)})`);
      check(/Ready \([\d.]+ MiB downloaded\)/.test(await page.textContent('#status')), 'ready status shown');
      await page.click('#btn-start');
      await waitPhase(page, 'running');
      check(await page.evaluate(() => Module.wasmBinary.byteLength) === prods[0].wasmSize, 'the glue got the decoded (raw) wasm bytes');
      check(await page.evaluate(() => Module.locateFile('WiiCompiled.wasm', '/p/')) === wasmName, 'locateFile maps the glue\'s wasm name to the hashed file');
      // second visit: the immutable file comes from the browser cache
      const page2 = await ctx.newPage();
      await page2.goto(base2);
      await waitPhase(page2, 'ready');
      const cached = await page2.evaluate((n) => performance.getEntriesByType('resource').filter((e) => e.name.endsWith(n)).map((e) => e.transferSize), wasmName);
      console.log(`INFO second visit wasm transferSize=${JSON.stringify(cached)}`);
      check(cached.length === 1 && cached[0] === 0, 'second visit serves the hashed wasm from the browser cache (transferSize 0)');
      await ctx.close();

      // stale/understated size field: progress must fall back to indeterminate instead of exceeding 100%
      const bad = JSON.parse(JSON.stringify(prods));
      bad[0].wasmSize = 1000;
      const ctx2 = await browser.newContext();
      const page3 = await ctx2.newPage();
      await page3.route('**/products.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bad) }));
      const pct3 = [];
      await page3.exposeFunction('__pct', (v) => pct3.push(v));
      await page3.addInitScript(() => {
        new MutationObserver(() => { const v = document.getElementById('progress')?.getAttribute('aria-valuenow'); if (v != null) window.__pct(Number(v)); })
          .observe(document, { subtree: true, attributes: true, attributeFilter: ['aria-valuenow'] });
      });
      await page3.goto(base2);
      await waitPhase(page3, 'ready');
      check(pct3.every((v) => v <= 100), 'wrong recorded size never shows progress above 100%');
      await ctx2.close();

      // a server that does not compress: no Content-Encoding, progress still right
      fs.rmSync(path.join(hashedSite, wasmName + '.gz'));
      const ctx3 = await browser.newContext();
      const page4 = await ctx3.newPage();
      const seen4 = [];
      page4.on('response', (r) => { if (r.url().endsWith('.wasm')) seen4.push(r.headers()); });
      await page4.goto(base2);
      await waitPhase(page4, 'ready');
      check(seen4.length === 1 && !seen4[0]['content-encoding'] && Number(seen4[0]['content-length']) === prods[0].wasmSize, 'without a .gz sibling the raw wasm is served and the page still works');
      await ctx3.close();
    } finally {
      server2.kill();
      fs.rmSync(hashedSite, { recursive: true, force: true });
    }
  }
} catch (e) {
  console.log('FAIL unexpected exception: ' + (e && e.stack || e));
  failures++;
}

console.log(`\nscreenshots: ${shotsDir}`);
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
server.kill();
fs.rmSync(siteDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0); // browser.close() can hang mid-JSPI
