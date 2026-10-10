#!/usr/bin/env node
// Drives web/tests/web_disc_test.cpp: builds a fake extracted disc tree (pseudo-random bytes,
// nested directories, an empty directory, awkward file names, a >16 MiB file), runs
// web/tools/make_disc_manifest.py on it, serves it with a Range-capable test server, then runs
// the wasm test under Node (JSPI) and in headless Chromium (two page loads: IDBFS write, then
// verify after reload). Build first: web/tests/run_web_disc_test.sh does both.
//
// usage: node web/tests/run_web_disc_test.mjs <dir with web_disc_test.mjs> [--no-node] [--no-browser]
// env:   MKW_JSPI_NODE   Node binary with JSPI (default: this node if it has it, else emsdk's)
//        MKW_CHROMIUM    Chromium binary (default /opt/pw-browsers/chromium)
//        MKW_PLAYWRIGHT  Playwright entry (default /opt/node-tools/node_modules/playwright/index.mjs)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './web_disc_test_server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = process.argv.slice(2);
const buildDir = args.find((a) => !a.startsWith('--'));
if (!buildDir || !fs.existsSync(path.join(buildDir, 'web_disc_test.mjs'))) {
  console.error('usage: node web/tests/run_web_disc_test.mjs <dir with web_disc_test.mjs> [--no-node] [--no-browser]');
  process.exit(2);
}
const runNode = !args.includes('--no-node');
const runBrowser = !args.includes('--no-browser');

const B = 256 * 1024; // WebDisc::kBlockSize
const MiB = 1024 * 1024;

// Must match Expected() in web_disc_test.cpp.
function expected(relPath, size) {
  let state = 2166136261 >>> 0;
  for (const ch of Buffer.from(relPath, 'utf8')) state = Math.imul(state ^ ch, 16777619) >>> 0;
  state = (state | 1) >>> 0;
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    for (let b = 0; b < 4 && i + b < size; ++b) out[i + b] = (state >>> (8 * b)) & 0xff;
  }
  return out;
}

const spec = {
  'sys/fst.bin': 4096,
  'sys/main.dol': 300_000,
  'sys/bi2.bin': 8192,
  'files/tiny.bin': 1,
  'files/empty.bin': 0,
  'files/Race/Course/castle_course.szs': 3 * B + 12_345,
  'files/Race/Course/exact_block.szs': B,
  'files/Race/Course/block_plus_one.szs': B + 1,
  'files/Race/Kart/kart Mario+Peach #1 %20.szs': 100_000,
  'files/Scene/UI/Title.szs': 700_000,
  'files/sound/strm/big_stream.brstm': 16 * MiB + 3 * B + 7,
  'files/norange/plain.bin': 600_000,
  'files/gone.bin': 5000,
  'files/truncated.bin': 900_000,
};
const emptyDirs = ['files/Empty/Nested'];
const missing = ['files/gone.bin'];
const truncated = { 'files/truncated.bin': 300_000 };
const noRange = ['files/norange/plain.bin'];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// --- Fake disc tree + manifest ---------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mkw-web-disc-test-'));
const site = path.join(work, 'site');
const disc = path.join(site, 'disc');
for (const [rel, size] of Object.entries(spec)) {
  const file = path.join(disc, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, expected(rel, size));
}
for (const rel of emptyDirs) fs.mkdirSync(path.join(disc, ...rel.split('/')), { recursive: true });

const manifestPath = path.join(site, 'disc-manifest.json');
const gen = spawnSync('python3', [path.join(repo, 'web/tools/make_disc_manifest.py'), disc, manifestPath],
                      { encoding: 'utf8' });
process.stdout.write(gen.stdout);
process.stderr.write(gen.stderr);
if (gen.status !== 0) fail('make_disc_manifest.py failed');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const sameFiles = JSON.stringify(Object.entries(manifest.files).sort()) === JSON.stringify(Object.entries(spec).sort());
if (manifest.format !== 'wiicompiled-disc-manifest' || manifest.version !== 1 || manifest.root !== 'disc/' ||
    !sameFiles || manifest.fileCount !== Object.keys(spec).length ||
    manifest.totalBytes !== Object.values(spec).reduce((a, b) => a + b, 0) ||
    !manifest.directories.includes('files/Empty/Nested') || !manifest.directories.includes('files/Empty') ||
    !manifest.directories.includes('files/Race/Kart')) {
  fail(`unexpected manifest: ${JSON.stringify({ ...manifest, files: Object.keys(manifest.files).length })}`);
}
const badGen = spawnSync('python3', [path.join(repo, 'web/tools/make_disc_manifest.py'), path.join(disc, 'files'),
                                     path.join(work, 'bad.json')], { encoding: 'utf8' });
if (badGen.status === 0) fail('make_disc_manifest.py accepted a directory without sys/fst.bin');
console.log('manifest generator: OK');

// Server-side damage the manifest does not know about.
for (const rel of missing) fs.rmSync(path.join(disc, ...rel.split('/')));
for (const [rel, size] of Object.entries(truncated)) fs.truncateSync(path.join(disc, ...rel.split('/')), size);

const testArgs = [
  ...Object.entries(spec).map(([rel, size]) => `--file=${rel}:${size}`),
  ...emptyDirs.map((rel) => `--dir=${rel}`),
  ...missing.map((rel) => `--missing=${rel}`),
  ...Object.entries(truncated).map(([rel, size]) => `--truncated=${rel}:${size}`),
  ...noRange.map((rel) => `--norange=${rel}`),
];

const page = `<!doctype html>
<meta charset="utf-8"><title>web disc test</title><pre id="log"></pre>
<script type="module">
const params = new URLSearchParams(location.search);
const config = await (await fetch('test-config.json')).json();
const out = document.getElementById('log');
const print = (line) => { console.log(line); out.textContent += line + '\\n'; };
const createModule = (await import('./build/web_disc_test.mjs')).default;
// No mkwDiscManifestUrl: exercises the default ('disc-manifest.json' next to the page).
createModule({
  arguments: [...config.args, '--persist=' + params.get('persist'), '--nonce=' + params.get('nonce')],
  print,
  printErr: (line) => console.warn(line),
  onAbort: (what) => print('FAIL: aborted: ' + what),
}).catch((e) => print('FAIL: ' + (e && e.stack || e)));
</script>
`;

const server = await startServer({
  mounts: [{ prefix: '/build/', dir: buildDir }, { prefix: '/', dir: site }],
  noRangePrefixes: noRange.map((rel) => `/disc/${rel}`),
  pages: {
    '/index.html': { type: 'text/html; charset=utf-8', body: page },
    '/test-config.json': { type: 'application/json', body: JSON.stringify({ args: testArgs }) },
  },
});
const origin = `http://127.0.0.1:${server.port}`;
console.log(`serving ${site} at ${origin}`);

// Sanity-check the test server's Range handling itself.
{
  const r = await fetch(`${origin}/disc/files/Race/Course/exact_block.szs`, { headers: { Range: 'bytes=10-19' } });
  const body = Buffer.from(await r.arrayBuffer());
  const want = expected('files/Race/Course/exact_block.szs', B).subarray(10, 20);
  if (r.status !== 206 || r.headers.get('content-range') !== `bytes 10-19/${B}` || !body.equals(want)) {
    fail(`test server Range answer: ${r.status} ${r.headers.get('content-range')}`);
  }
  const past = await fetch(`${origin}/disc/files/tiny.bin`, { headers: { Range: 'bytes=5-9' } });
  if (past.status !== 416) fail(`test server should answer 416 past EOF, got ${past.status}`);
}

let failed = false;

// --- Node -----------------------------------------------------------------------------------
if (runNode) {
  const emsdkNode = '/opt/emsdk/node/24.19.0_64bit/bin/node';
  const jspiNode = process.env.MKW_JSPI_NODE ||
    (typeof WebAssembly.Suspending == 'function' ? process.execPath : emsdkNode);
  console.log(`--- Node (${jspiNode})`);
  const before = server.log.length;
  // spawnSync would block this process's event loop and with it the server, so spawn async.
  const { spawn } = await import('node:child_process');
  const child = spawn(jspiNode, ['--experimental-wasm-jspi', path.join(here, 'web_disc_node_host.mjs'),
                                 path.resolve(buildDir, 'web_disc_test.mjs'), `${origin}/disc-manifest.json`,
                                 JSON.stringify([...testArgs, '--persist=none'])],
                      { stdio: 'inherit' });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  const requests = server.log.slice(before);
  const ranged = requests.filter((r) => r.range).length;
  const notFound = requests.filter((r) => r.status === 404).map((r) => r.path);
  console.log(`node: exit ${code}; ${requests.length} HTTP requests (${ranged} with Range); 404s: ${notFound.join(', ')}`);
  if (code !== 0) failed = true;
  if (!notFound.includes('/disc/files/gone.bin')) {
    console.error('FAIL: expected the missing file to be requested and answered 404');
    failed = true;
  }
  if (!requests.some((r) => r.path === '/disc/files/Race/Kart/kart Mario+Peach #1 %20.szs' && r.status === 206)) {
    console.error('FAIL: file name with special characters was not fetched correctly');
    failed = true;
  }
}

// --- Chromium -------------------------------------------------------------------------------
if (runBrowser) {
  console.log('--- Chromium');
  const playwrightEntry = process.env.MKW_PLAYWRIGHT || '/opt/node-tools/node_modules/playwright/index.mjs';
  const { chromium } = await import(playwrightEntry);
  const executablePath = process.env.MKW_CHROMIUM || '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(executablePath) ? executablePath : undefined,
  });
  const context = await browser.newContext();
  const tab = await context.newPage();
  let waiter = null;
  const lines = [];
  tab.on('console', (msg) => {
    const text = msg.text();
    lines.push(text);
    console.log(`[chromium] ${text}`);
    if (waiter && /^(PASS|FAIL) web disc test|^FAIL: /.test(text)) waiter(text);
  });
  tab.on('pageerror', (error) => {
    console.log(`[chromium] pageerror: ${error.message}`);
    waiter?.(`FAIL: pageerror ${error.message}`);
  });
  const runPage = async (query) => {
    const result = new Promise((resolve) => {
      waiter = resolve;
      setTimeout(() => resolve('FAIL: timed out'), 180_000);
    });
    await tab.goto(`${origin}/index.html?${query}`);
    const line = await result;
    waiter = null;
    return line;
  };
  const nonce = Math.random().toString(36).slice(2);
  const first = await runPage(`persist=write&nonce=${nonce}`);
  if (!first.startsWith('PASS')) failed = true;
  // Give IDBFS autoPersist (setTimeout + IndexedDB transaction) time to store the unflushed file.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const second = await runPage(`persist=verify&nonce=${nonce}`);
  if (!second.startsWith('PASS')) failed = true;
  console.log(`chromium: write run: ${first}`);
  console.log(`chromium: reload run: ${second}`);
  // browser.close() can hang while a JSPI stack is parked; the process exits below instead.
}

await server.close().catch(() => {});
fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? 'FAIL web disc suite' : 'PASS web disc suite');
process.exit(failed ? 1 : 0);
