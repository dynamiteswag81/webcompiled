#!/usr/bin/env node
// Drives web/tests/web_disc_test.cpp and web/tests/web_riivolution_test.cpp: builds a fake
// extracted disc tree (pseudo-random bytes, nested directories, an empty directory, awkward file
// names, a >16 MiB file) and a fake Retro Rewind pack (mods/RetroRewind6: Riivolution XMLs plus
// files/folders), runs web/tools/make_disc_manifest.py on both (--tree for the pack), serves
// them with a Range-capable test server, then runs the wasm tests under Node (JSPI) and in
// headless Chromium (disc test: IDBFS write, a second tab at the same time that must be read-only,
// then verify after both closed; a run without navigator.locks; riivolution).
// Build first: web/tests/run_web_disc_test.sh does both.
//
// usage: node web/tests/run_web_disc_test.mjs <dir with the test .mjs files> [--no-node] [--no-browser]
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

// --- Fake Retro Rewind pack (layout documented in web_riivolution_test.cpp) ------------------
const packDir = path.join(site, 'mods', 'RetroRewind6');
const packFiles = {
  'Scene/UI/MenuSingle_E.szs': 70_000,
  'Binaries/Code.pul': 4100,
  'Race/Course/castle.szs': 300_000,
  'Race/Course/mario.szs': 1234,
  'Race/Course/sub/old_course.szs': 99_999,
  'ByName/Award.szs': 5000,
  'Extras/extra.bin': 10,
};
for (const [rel, size] of Object.entries(packFiles)) {
  const file = path.join(packDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, expected(rel, size));
}
const packXml = `<?xml version="1.0" encoding="UTF-8"?>
<wiidisc version="1" root="/RetroRewind6">
  <id game="RMC"/>
  <options>
    <section name="Retro Rewind">
      <option name="Pack">
        <choice name="Enabled"><patch id="pack"/></choice>
      </option>
      <option name="Extras">
        <choice name="Enabled"><patch id="extras"/></choice>
      </option>
    </section>
  </options>
  <patch id="pack">
    <file external="Scene/UI/MenuSingle_E.szs" disc="/Scene/UI/MenuSingle_E.szs"/>
    <file external="Scene/UI/missing.szs" disc="/Scene/UI/missing.szs"/>
    <file external="binaries/code.pul" disc="/rr/Code.pul" create="true"/>
    <folder external="Race/Course" disc="/Race/Course" create="true"/>
    <folder external="ByName"/>
    <savegame external="/RetroRewind6/save/RetroWFC" clone="false"/>
  </patch>
  <patch id="extras">
    <file external="Extras/extra.bin" disc="/extra.bin" create="true"/>
  </patch>
</wiidisc>
`;
fs.mkdirSync(path.join(packDir, 'xml'), { recursive: true });
fs.writeFileSync(path.join(packDir, 'xml', 'RetroRewind6.xml'), packXml);
fs.mkdirSync(path.join(packDir, 'riivolution'), { recursive: true });
fs.writeFileSync(path.join(packDir, 'riivolution', 'Alt.xml'), '<wiidisc version="1"/>\n');
fs.writeFileSync(path.join(packDir, 'riivolution', 'notes.txt'), 'not an xml\n');
const packManifestPath = path.join(site, 'mods', 'RetroRewind6-manifest.json');
const refused = spawnSync('python3', [path.join(repo, 'web/tools/make_disc_manifest.py'), packDir, packManifestPath],
                          { encoding: 'utf8' });
if (refused.status === 0) fail('make_disc_manifest.py accepted a mod pack without --tree');
const packGen = spawnSync('python3', [path.join(repo, 'web/tools/make_disc_manifest.py'), '--tree', packDir,
                                      packManifestPath], { encoding: 'utf8' });
process.stdout.write(packGen.stdout);
process.stderr.write(packGen.stderr);
if (packGen.status !== 0) fail('make_disc_manifest.py --tree failed');
const packManifest = JSON.parse(fs.readFileSync(packManifestPath, 'utf8'));
if (packManifest.root !== 'RetroRewind6/' || packManifest.fileCount !== Object.keys(packFiles).length + 3) {
  fail(`unexpected pack manifest: root ${packManifest.root}, ${packManifest.fileCount} files`);
}
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

// One page for every test module; ?test= picks the entry from test-config.json.
const page = `<!doctype html>
<meta charset="utf-8"><title>web disc test</title><pre id="log"></pre>
<script type="module">
const params = new URLSearchParams(location.search);
const config = (await (await fetch('test-config.json')).json())[params.get('test')];
const out = document.getElementById('log');
const print = (line) => { console.log(line); out.textContent += line + '\\n'; };
const createModule = (await import('./build/' + config.module)).default;
// No manifest URLs: exercises the defaults ('disc-manifest.json' next to the page, and
// mkwProduct.modRoot + '-manifest.json' for the mod pack).
const extra = params.get('persist') ? ['--persist=' + params.get('persist'), '--nonce=' + params.get('nonce')] : [];
createModule({
  ...config.options,
  arguments: [...config.args, ...extra],
  print,
  printErr: (line) => console.warn(line),
  onAbort: (what) => print('FAIL: aborted: ' + what),
}).catch((e) => print('FAIL: ' + (e && e.stack || e)));
</script>
`;
const retroRewind = { id: 'RetroRewind', modRoot: 'mods/RetroRewind6' };
const browserTests = {
  disc: { module: 'web_disc_test.mjs', args: testArgs, options: {} },
  riivolution: { module: 'web_riivolution_test.mjs', args: ['--pack'], options: { mkwProduct: retroRewind } },
};

const server = await startServer({
  mounts: [{ prefix: '/build/', dir: buildDir }, { prefix: '/', dir: site }],
  noRangePrefixes: noRange.map((rel) => `/disc/${rel}`),
  pages: {
    '/index.html': { type: 'text/html; charset=utf-8', body: page },
    '/test-config.json': { type: 'application/json', body: JSON.stringify(browserTests) },
  },
});
const origin = `http://127.0.0.1:${server.port}`;
console.log(`serving ${site} at ${origin}`);

let failed = false;

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


// --- Node -----------------------------------------------------------------------------------
const DONE = /^(PASS|FAIL) web (disc|riivolution) test|^FAIL: /;
if (runNode) {
  const emsdkNode = '/opt/emsdk/node/24.19.0_64bit/bin/node';
  const jspiNode = process.env.MKW_JSPI_NODE ||
    (typeof WebAssembly.Suspending == 'function' ? process.execPath : emsdkNode);
  // spawnSync would block this process's event loop and with it the server, so spawn async.
  const { spawn } = await import('node:child_process');
  const runModule = async (label, module, options) => {
    console.log(`--- Node: ${label} (${jspiNode})`);
    const before = server.log.length;
    const child = spawn(jspiNode, ['--experimental-wasm-jspi', path.join(here, 'web_disc_node_host.mjs'),
                                   path.resolve(buildDir, module), JSON.stringify(options)],
                        { stdio: 'inherit' });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    if (code !== 0) failed = true;
    return { code, requests: server.log.slice(before) };
  };

  const disc = await runModule('disc', 'web_disc_test.mjs', {
    arguments: [...testArgs, '--persist=none'],
    mkwDiscManifestUrl: `${origin}/disc-manifest.json`,
  });
  const ranged = disc.requests.filter((r) => r.range).length;
  const notFound = disc.requests.filter((r) => r.status === 404).map((r) => r.path);
  console.log(`node disc: exit ${disc.code}; ${disc.requests.length} HTTP requests (${ranged} with Range); ` +
              `404s: ${notFound.join(', ')}`);
  if (!notFound.includes('/disc/files/gone.bin')) {
    console.error('FAIL: expected the missing file to be requested and answered 404');
    failed = true;
  }
  if (!disc.requests.some((r) => r.path === '/disc/files/Race/Kart/kart Mario+Peach #1 %20.szs' && r.status === 206)) {
    console.error('FAIL: file name with special characters was not fetched correctly');
    failed = true;
  }

  // Node has no page URL, so the mod manifest URL is given absolutely; modRoot still names the
  // mount (/mods/RetroRewind6).
  const riivo = await runModule('riivolution', 'web_riivolution_test.mjs', {
    arguments: ['--pack'],
    mkwProduct: retroRewind,
    mkwModManifestUrl: `${origin}/mods/RetroRewind6-manifest.json`,
    mkwDiscPrefetchManifest: false,
  });
  const packReads = riivo.requests.filter((r) => r.path.startsWith('/mods/RetroRewind6/') && r.status === 206);
  console.log(`node riivolution: exit ${riivo.code}; ${packReads.length} Range reads from the pack; ` +
              `disc requests: ${riivo.requests.filter((r) => r.path.startsWith('/disc')).length}`);
  if (riivo.requests.some((r) => r.path.startsWith('/disc'))) {
    console.error('FAIL: the riivolution test should never touch the disc mount');
    failed = true;
  }
  const noPack = await runModule('riivolution, missing pack manifest', 'web_riivolution_test.mjs', {
    arguments: ['--no-pack'],
    mkwProduct: retroRewind,
    mkwModManifestUrl: `${origin}/mods/missing-manifest.json`,
    mkwDiscPrefetchManifest: false,
  });
  console.log(`node riivolution (no pack): exit ${noPack.code}`);
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
  const lines = []; // every console line of every page, for the assertions below
  // Opens a page in the shared context (same origin, so same IndexedDB and same Web Locks).
  const openTab = async (name, init) => {
    const tab = await context.newPage();
    if (init) await tab.addInitScript(init);
    const t = { tab, name, waiter: null };
    tab.on('console', (msg) => {
      const text = msg.text();
      lines.push({ name, text });
      console.log(`[chromium ${name}] ${text}`);
      if (t.waiter && DONE.test(text)) t.waiter(text);
    });
    tab.on('pageerror', (error) => {
      console.log(`[chromium ${name}] pageerror: ${error.message}`);
      t.waiter?.(`FAIL: pageerror ${error.message}`);
    });
    return t;
  };
  const runPage = async (t, query) => {
    const result = new Promise((resolve) => {
      t.waiter = resolve;
      setTimeout(() => resolve('FAIL: timed out'), 180_000);
    });
    await t.tab.goto(`${origin}/index.html?${query}`);
    const line = await result;
    t.waiter = null;
    return line;
  };
  // page.close() can wait on a parked JSPI stack; do not let it stall the suite.
  const closeTab = (t) => Promise.race([t.tab.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  const expectPass = (label, line) => {
    console.log(`chromium: ${label}: ${line}`);
    if (!line.startsWith('PASS')) failed = true;
  };
  // Give IDBFS autoPersist (setTimeout + IndexedDB transaction) time to store the unflushed file.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 2000));

  const nonce = Math.random().toString(36).slice(2);

  // Tab A owns the save store (holds the Web Lock) and stays open.
  const tabA = await openTab('A');
  expectPass('disc write run (tab A)', await runPage(tabA, `test=disc&persist=write&nonce=${nonce}`));
  await settle();

  // Tab B, same browser profile, while A is alive: must come up read-only, see A's saves, and
  // never write (its tampered/new files must not reach IndexedDB).
  const tabB = await openTab('B');
  expectPass('disc read-only run (tab B, A still open)', await runPage(tabB, `test=disc&persist=readonly&nonce=${nonce}`));
  if (!lines.some((l) => l.name === 'B' && l.text.includes("This game is open in another tab; progress here won't be saved"))) {
    console.error('FAIL: the read-only tab did not log the "open in another tab" message');
    failed = true;
  }
  if (lines.some((l) => l.name === 'A' && l.text.includes('another tab'))) {
    console.error('FAIL: the first tab must not report being read-only');
    failed = true;
  }
  await settle(); // time for a (wrong) autoPersist of B's writes to show up in IndexedDB
  await closeTab(tabB);
  await closeTab(tabA);

  // Tab C: after both closed it owns the store again and sees exactly what A stored.
  const tabC = await openTab('C');
  expectPass('disc reload run (tab C, A and B closed)', await runPage(tabC, `test=disc&persist=verify&nonce=${nonce}`));
  await closeTab(tabC);

  // Reload of the owning tab: the old document's lock must not leave the new one read-only.
  const tabD = await openTab('D');
  expectPass('disc owner run (tab D)', await runPage(tabD, `test=disc&persist=verify&nonce=${nonce}`));
  expectPass('disc reload of the owning tab (tab D)', await runPage(tabD, `test=disc&persist=verify&nonce=${nonce}`));
  await closeTab(tabD);

  // No navigator.locks (old browser / insecure context): the previous behaviour plus a warning.
  const tabE = await openTab('E', () => {
    Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true });
  });
  expectPass('disc run without Web Locks (tab E)', await runPage(tabE, `test=disc&persist=nolocks&nonce=${nonce}`));
  if (!lines.some((l) => l.name === 'E' && /navigator\.locks is unavailable/.test(l.text))) {
    console.error('FAIL: no console warning when navigator.locks is unavailable');
    failed = true;
  }
  await closeTab(tabE);

  const tabF = await openTab('F');
  expectPass('riivolution run', await runPage(tabF, 'test=riivolution'));
  // browser.close() can hang while a JSPI stack is parked; the process exits below instead.
}

await server.close().catch(() => {});
fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? 'FAIL web disc suite' : 'PASS web disc suite');
process.exit(failed ? 1 : 0);
