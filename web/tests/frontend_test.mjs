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
import { spawn } from 'node:child_process';
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
    check((await page.textContent('#help')).includes('Placeholder'), 'help marks the mapping as placeholder');
    check((await page.textContent('#help')).toLowerCase().includes('gamepad api'), 'help mentions the Gamepad API');
    await shot(page, '5-help');
    await page.keyboard.press('Escape');
    check(!(await page.isVisible('#help')), 'Escape closes the controls overlay');
    await page.keyboard.press('h');
    check(await page.isVisible('#help'), 'H opens the controls overlay');
    await page.keyboard.press('h');
    check(!(await page.isVisible('#help')), 'H closes the controls overlay');
    await page.click('#btn-help');
    check(await page.isVisible('#help'), 'Controls button opens the overlay');
    await page.click('#btn-help-close');
    check(!(await page.isVisible('#help')), 'Close button closes the overlay');

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
    const lines = details.split('\n').filter((l) => /^\[\s*[\d.]+\] /.test(l));
    check(lines.length === 200 && details.includes('spam 999') && !details.includes('spam 100\n'), `console buffer capped at 200 lines (got ${lines.length})`);
    await page.context().close();
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
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.WiiCompiledUI.showError('manual', 'x'.repeat(300)));
    check(await noHScroll(page), 'phone: no horizontal scroll (error)');
    await shot(page, '10-phone-error');
    await page.context().close();
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
} catch (e) {
  console.log('FAIL unexpected exception: ' + (e && e.stack || e));
  failures++;
}

console.log(`\nscreenshots: ${shotsDir}`);
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
server.kill();
fs.rmSync(siteDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0); // browser.close() can hang mid-JSPI
