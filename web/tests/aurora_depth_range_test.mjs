// Headless Chromium test of aurora's depth_range example (aurora-main/examples/depth_range.c):
// GX viewports whose depth range lies outside [0, 1] (docs/web-test-report.md C1), started with a
// 0x0 canvas (C3).
//
//   node web/tests/aurora_depth_range_test.mjs BUILD_DIR [LOGFILE]
//
// BUILD_DIR is an emcmake build of aurora-main with the depth_range target built
// (emcmake cmake -S aurora-main -B BUILD_DIR -G Ninja -DCMAKE_BUILD_TYPE=Release &&
//  ninja -C BUILD_DIR depth_range); the page is BUILD_DIR/examples/depth_range.html.
//
// Checks, in one page load:
//   * the canvas is display:none when the module starts: aurora logs that it waits for the canvas
//     and does not create the surface until the canvas is shown (no beginRenderPass TypeError);
//   * once shown, every case of the example reads back the depth GX would store
//     ("DEPTH-RANGE-TEST PASS"), including the clamped parts of an out-of-range range;
//   * no WebGPU validation error is reported and nothing aborts or traps.
// Exit code 0 on success. The log goes to LOGFILE with fs.appendFileSync and the script ends
// with process.exit: browser.close() can hang while a JSPI stack is suspended.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const buildDir = process.argv[2];
const logFile = process.argv[3] || path.join(os.tmpdir(), 'aurora-depth-range-test.log');
if (!buildDir) {
  console.error('usage: aurora_depth_range_test.mjs BUILD_DIR [LOGFILE]');
  process.exit(2);
}
const pageDir = path.resolve(buildDir, 'examples');
if (!fs.existsSync(path.join(pageDir, 'depth_range.html'))) {
  console.error(`${pageDir}/depth_range.html not found (build the depth_range target)`);
  process.exit(2);
}
fs.writeFileSync(logFile, '');
const t0 = Date.now();
const log = (line) => {
  const text = `[${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}] ${line}`;
  fs.appendFileSync(logFile, text + '\n');
  console.log(text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const file = path.join(pageDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(pageDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/depth_range.html`;

const pw = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
  : '/opt/node-tools/node_modules/playwright/index.mjs');
const { chromium } = pw.default ?? pw;

const problems = [];
const lines = [];
let verdict = 1;
try {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--no-sandbox'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 768 } })).newPage();
  const BAD = [/WebGPU error/, /RuntimeError/, /SuspendError/, /Aborted\(/, /unreachable/, /FATAL/,
    /memory access out of bounds/, /beginRenderPass/, /Uncaught/];
  page.on('console', (msg) => {
    for (const line of msg.text().split('\n')) {
      lines.push(line);
      log(`console.${msg.type()}: ${line}`);
      if (BAD.some((re) => re.test(line))) problems.push(line);
    }
  });
  page.on('pageerror', (e) => { log(`pageerror: ${e.name}: ${e.message}`); problems.push(`${e.name}: ${e.message}`); });
  // Test-browser shim: aurora's GX shaders declare `array_start: array<u32, 12>` in a uniform
  // struct, which needs the WGSL language feature uniform_buffer_standard_layout (Chrome/Edge
  // 14x+; the local session's Edge 154 has it). The Chromium 141 used here does not, so rewrite
  // that member to the identical-layout array<vec4u, 3> (it sits at offset 32, 16-byte aligned).
  // Nothing else in the shaders is touched.
  await page.addInitScript(() => {
    if (!self.GPUDevice || (navigator.gpu && navigator.gpu.wgslLanguageFeatures &&
        navigator.gpu.wgslLanguageFeatures.has('uniform_buffer_standard_layout'))) return;
    const create = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (descriptor) {
      let code = descriptor && descriptor.code;
      if (typeof code === 'string' && code.includes('array_start: array<u32, 12>')) {
        code = code.replace('array_start: array<u32, 12>', 'array_start: array<vec4u, 3>')
          .replace(/ubuf\.array_start\[(\d+)\]/g, (_, n) => `ubuf.array_start[${Math.floor(n / 4)}][${n % 4}]`);
        descriptor = { ...descriptor, code };
      }
      return create.call(this, descriptor);
    };
  });
  // C3: the canvas has no layout box when the module starts.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const canvas = document.getElementById('canvas');
      if (canvas) canvas.style.display = 'none';
    });
  });
  await page.goto(url);
  await sleep(4000);
  const waited = lines.some((l) => /Waiting for the canvas before creating the surface/.test(l));
  const surfaceEarly = lines.some((l) => /Using framebuffer size/.test(l));
  log(`0x0 canvas start: waited=${waited}, surface created while 0x0=${surfaceEarly}`);
  if (!waited) problems.push('aurora did not wait for the 0x0 canvas');
  if (surfaceEarly) problems.push('aurora created the surface while the canvas was 0x0');
  await page.evaluate(() => { document.getElementById('canvas').style.display = ''; });

  const deadline = Date.now() + 90000;
  let result = null;
  while (Date.now() < deadline && !result) {
    result = lines.find((l) => /^DEPTH-RANGE-TEST (PASS|FAIL)$/.test(l)) || null;
    await sleep(250);
  }
  if (!result) problems.push('no DEPTH-RANGE-TEST verdict within 90 s');
  else if (result !== 'DEPTH-RANGE-TEST PASS') problems.push(result);
  if (!lines.some((l) => /Canvas is ready; creating the surface/.test(l))) problems.push('no "Canvas is ready" log');
  // Let a few more frames run so a late validation error would still be seen.
  await sleep(2000);
  try {
    await page.screenshot({ path: logFile.replace(/\.log$/, '') + '.png', timeout: 5000 });
  } catch (e) { log(`screenshot failed: ${e.message}`); }
  for (const p of problems) log(`problem: ${p}`);
  verdict = problems.length ? 1 : 0;
  log(verdict === 0 ? 'AURORA DEPTH RANGE TEST PASS' : 'AURORA DEPTH RANGE TEST FAIL');
} catch (e) {
  log(`driver error: ${e && e.stack || e}`);
}
console.log(`full log: ${logFile}`);
process.exit(verdict);
