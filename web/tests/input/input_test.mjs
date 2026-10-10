// Headless-Chromium test of browser input, with no hardware: fake gamepads (navigator.getGamepads
// overridden, gamepadconnected / gamepaddisconnected dispatched) and real key events go through
// SDL3's Emscripten backend and aurora's PAD library into the input harness (input_harness.cpp,
// hosted by the real page web/site), and the test reads what PADRead returned per port from
// Module.mkwInput (web/js/library_mkw_input.js).
//
//   node web/tests/input/input_test.mjs SITE_DIR [--shots DIR]
//
// SITE_DIR holds web/site plus the harness's WiiCompiled.js/.wasm (run_input_test.sh assembles
// it). Ends with process.exit: browser.close() can hang while a JSPI stack is suspended.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '../..');
const siteDir = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(siteDir, 'WiiCompiled.wasm'))) {
  console.error('usage: input_test.mjs SITE_DIR [--shots DIR]   (SITE_DIR needs WiiCompiled.js/.wasm)');
  process.exit(2);
}
const shotsDir = (() => {
  const i = process.argv.indexOf('--shots');
  return i > 0 ? path.resolve(process.argv[i + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'wc-input-shots-'));
})();
fs.mkdirSync(shotsDir, { recursive: true });

const pw = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
  : '/opt/node-tools/node_modules/playwright/index.mjs');
const { chromium } = pw.default ?? pw;

const port = 18000 + Math.floor(Math.random() * 2000);
const server = spawn('python3', [path.join(webDir, 'serve.py'), '--dir', siteDir, '--port', String(port), '-q'], { stdio: 'inherit' });
const base = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}

let failures = 0;
function check(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake Gamepad API. Each pad is a plain object shaped like a Chrome Gamepad with the "standard"
// mapping (17 buttons, 4 axes); getGamepads() returns the live slots, like the browser does.
function installFakeGamepads() {
  const slots = [null, null, null, null];
  window.__padEffects = [];
  const button = () => ({ pressed: false, touched: false, value: 0 });
  window.__pad = {
    connect(index, id, mapping = 'standard') {
      const pad = {
        id, index, mapping, connected: true, timestamp: performance.now(),
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, button),
        vibrationActuator: {
          type: 'dual-rumble',
          playEffect(type, params) {
            window.__padEffects.push({ index, type, strong: params.strongMagnitude, weak: params.weakMagnitude, duration: params.duration, t: performance.now() });
            return Promise.resolve('complete');
          },
          reset() { window.__padEffects.push({ index, type: 'reset', t: performance.now() }); return Promise.resolve('complete'); },
        },
      };
      slots[index] = pad;
      const ev = new Event('gamepadconnected');
      ev.gamepad = pad;
      window.dispatchEvent(ev);
    },
    disconnect(index) {
      const pad = slots[index];
      if (!pad) return;
      pad.connected = false;
      slots[index] = null;
      const ev = new Event('gamepaddisconnected');
      ev.gamepad = pad;
      window.dispatchEvent(ev);
    },
    button(index, b, value) {
      const pad = slots[index];
      pad.buttons[b] = { pressed: value > 0.5, touched: value > 0, value };
      pad.timestamp = performance.now();
    },
    axis(index, a, value) {
      const pad = slots[index];
      pad.axes[a] = value;
      pad.timestamp = performance.now();
    },
  };
  Object.defineProperty(Navigator.prototype, 'getGamepads', { value: () => slots.slice(), configurable: true });
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
    '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--no-sandbox'],
});

const consoleLines = [];
async function startPage(page) {
  await page.goto(base + '?inputdebug=1');
  await page.waitForFunction(() => document.documentElement.dataset.phase === 'ready', null, { timeout: 60000 });
  // No disc in this harness: do not prefetch the disc manifest (library_mkw_dvd.js).
  await page.evaluate(() => { window.Module.mkwDiscPrefetchManifest = false; });
  await page.click('#btn-start');
  await page.waitForFunction(() => window.Module.mkwHarness && window.Module.mkwHarness.frames > 10 &&
    window.Module.mkwInput && window.Module.mkwInput.ports(), null, { timeout: 90000 });
}
const ports = (page) => page.evaluate(() => window.Module.mkwInput.ports());
const desc = (page) => page.evaluate(() => window.Module.mkwInput.description());
// Waits until fn(ports) is true; returns the ports it saw last.
async function waitPorts(page, fn, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await ports(page);
    try { if (last && fn(last)) return last; } catch { /* keep polling */ }
    await sleep(30);
  }
  console.log(`  (timed out waiting for ${what}; last ports ${JSON.stringify(last)})`);
  return null;
}
async function waitDesc(page, fn, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await desc(page);
    try { if (last && fn(last)) return last; } catch { /* keep polling */ }
    await sleep(30);
  }
  console.log(`  (timed out waiting for ${what}; last description ${JSON.stringify(last)})`);
  return null;
}

// What each entry of the page's KEYBOARD_LAYOUT must do to port 1.
const BUTTON_OF = {
  'A': 'A', 'B': 'B', 'X': 'X', 'Y': 'Y', 'Start': 'Start', 'Z': 'Z', 'L': 'L', 'R': 'R',
  'D-pad up': 'Up', 'D-pad down': 'Down', 'D-pad left': 'Left', 'D-pad right': 'Right',
};
const AXIS_OF = {
  'Stick right': (p) => p.stickX === 127, 'Stick left': (p) => p.stickX === -127,
  'Stick up': (p) => p.stickY === 127, 'Stick down': (p) => p.stickY === -127,
  'C-stick right': (p) => p.substickX === 127, 'C-stick left': (p) => p.substickX === -127,
  'C-stick up': (p) => p.substickY === 127, 'C-stick down': (p) => p.substickY === -127,
  'R analog': (p) => p.triggerR === 255, 'L analog': (p) => p.triggerL === 255,
};
const neutral = (p) => p.button === 0 && p.stickX === 0 && p.stickY === 0 && p.substickX === 0 &&
  p.substickY === 0 && p.triggerL === 0 && p.triggerR === 0;

// Chrome on Windows names XInput pads without a vendor / product id; SDL then assumes an Xbox 360 pad.
const XBOX = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';
const DUALSHOCK = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';
const SWITCH_PRO = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)';

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(installFakeGamepads);
  const page = await ctx.newPage();
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => { consoleLines.push(`pageerror: ${e.message}`); check(false, `page error: ${e.message}`); });
  await startPage(page);
  check(true, 'harness runs in the real page (JSPI main, aurora, SDL, PADRead every frame)');

  // ---- 1. keyboard with no setup ----------------------------------------------------------
  let p = await ports(page);
  check(p[0].connected && p[0].keyboard && !p[0].controller, 'port 1 exists with no setup: keyboard active, no gamepad');
  check(p.slice(1).every((x) => !x.connected), 'ports 2-4 report no controller');
  const layout = await page.evaluate(() => window.WiiCompiledInput.KEYBOARD_LAYOUT);
  for (const entry of layout) {
    await page.keyboard.down(entry.code);
    const want = BUTTON_OF[entry.control];
    const ok = await waitPorts(page, (q) => want ? q[0].buttons.includes(want) : AXIS_OF[entry.control](q[0]),
      `${entry.code} -> ${entry.control}`, 3000);
    await page.keyboard.up(entry.code);
    check(!!ok, `key ${entry.code} (${entry.key}) drives ${entry.control}`);
    await waitPorts(page, (q) => neutral(q[0]), 'release', 3000);
  }
  await page.keyboard.down('ShiftLeft');
  p = await waitPorts(page, (q) => q[0].buttons.includes('R'), 'Shift');
  check(p && p[0].triggerR === 255 && p[0].buttons.join() === 'R', 'Shift = R button plus a full analog R pull');
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('ArrowLeft');
  p = await waitPorts(page, (q) => q[0].stickX === -127 && q[0].stickY === 127, 'up-left');
  check(!!p, 'two arrows give a diagonal');
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('ArrowLeft');

  // ---- 1b. on-screen touch controls (web/site/touch.js -> Module.mkwInput.setTouch) ---------
  const setTouch = (t) => page.evaluate((x) => window.Module.mkwInput.setTouch(x), t);
  check(await setTouch({ active: true, button: 0x0100 | 0x0020, stickX: -90, stickY: 50, triggerR: 255 }) === true,
    'setTouch writes once the runtime attached');
  p = await waitPorts(page, (q) => q[0].touch && q[0].buttons.join() === 'A,R', 'touch A + R');
  check(p && p[0].stickX === -90 && p[0].stickY === 50 && p[0].triggerR === 255 && p[0].keyboard,
    `touch: A + R and the analog stick reach port 1, next to the keyboard (${p && JSON.stringify(p[0])})`);
  await page.keyboard.down('KeyZ');
  await page.keyboard.down('ArrowRight');
  p = await waitPorts(page, (q) => q[0].buttons.join() === 'A,B,R' && q[0].stickX === 127, 'touch + keyboard');
  check(!!p && p[0].stickY === 50, 'touch: merged with the keyboard (buttons ORed, the larger deflection wins per axis)');
  await page.keyboard.up('KeyZ');
  await page.keyboard.up('ArrowRight');
  await setTouch({ active: false, button: 0x0100, stickX: 100 });
  p = await waitPorts(page, (q) => !q[0].touch && neutral(q[0]), 'touch hidden');
  check(!!p, 'touch: nothing reaches the game while the controls are hidden');
  check(p && p.slice(1).every((x) => !x.connected), 'touch: only port 1 is affected');

  let d = await waitDesc(page, (x) => x.ports[0].keys.length === 22, 'port 1 keys');
  const live = new Map((d ? d.ports[0].keys : []).map((k) => [k.control, k.key]));
  const mismatched = layout.filter((e) => live.get(e.control) !== e.sdlName);
  check(d && d.merge === true && mismatched.length === 0,
    `game reports the default layout on port 1, merged mode (mismatches: ${JSON.stringify(mismatched.map((e) => [e.control, live.get(e.control)]))})`);

  // ---- 2. first gamepad joins port 1 next to the keyboard -----------------------------------
  await page.evaluate((id) => window.__pad.connect(0, id), XBOX);
  d = await waitDesc(page, (x) => x.ports[0].pad, 'Xbox pad on port 1');
  check(d && d.ports[0].pad.family === 'xbox' && /xbox/.test(d.ports[0].pad.type), `hot-plugged Xbox pad -> port 1 (${d && JSON.stringify(d.ports[0].pad && { name: d.ports[0].pad.name, type: d.ports[0].pad.type })})`);
  const padLayouts = await page.evaluate(() => window.WiiCompiledInput.PAD_LAYOUTS);
  const layoutMatches = (pad, family) => pad && pad.buttons.every((b) => {
    const row = padLayouts.find((r) => r.control === b.control);
    return row && row[family] === b.input;
  }) && pad.buttons.length === padLayouts.length;
  check(d && layoutMatches(d.ports[0].pad, 'xbox'), `Xbox default layout matches the panel (${d && JSON.stringify(d.ports[0].pad.buttons)})`);
  p = await waitPorts(page, (q) => q[0].controller && q[0].keyboard && q[0].merged, 'merged flags');
  check(!!p, 'port 1 = keyboard + gamepad, merged');
  await sleep(300);
  p = await ports(page);
  check(neutral(p[0]), `a pad at rest reads neutral (C-stick / triggers not seeded in XInput order) (${JSON.stringify(p[0])})`);

  await page.evaluate(() => window.__pad.button(0, 0, 1));
  p = await waitPorts(page, (q) => q[0].buttons.includes('A'), 'pad A');
  check(!!p, 'pad south button -> A on port 1');
  await page.keyboard.down('KeyZ');
  p = await waitPorts(page, (q) => q[0].buttons.includes('A') && q[0].buttons.includes('B'), 'pad A + key B');
  check(!!p, 'merge: pad A and keyboard B held together -> A + B');
  await page.keyboard.up('KeyZ');
  await page.evaluate(() => window.__pad.button(0, 0, 0));

  await page.evaluate(() => window.__pad.axis(0, 0, 0.5));
  p = await waitPorts(page, (q) => q[0].stickX > 50, 'pad stick');
  check(p && p[0].stickX >= 60 && p[0].stickX <= 65, `pad stick at 0.5 -> stickX ${p && p[0].stickX}`);
  await page.keyboard.down('ArrowLeft');
  p = await waitPorts(page, (q) => q[0].stickX === -127, 'key beats pad');
  check(!!p, 'merge: keyboard full left beats pad half right (larger deflection wins)');
  await page.keyboard.up('ArrowLeft');
  p = await waitPorts(page, (q) => q[0].stickX > 50, 'pad back');
  check(!!p, 'merge: releasing the key gives the pad back');
  await page.evaluate(() => window.__pad.axis(0, 1, -1));
  p = await waitPorts(page, (q) => q[0].stickY > 120, 'pad up');
  check(!!p, 'pad stick up (browser -1) -> GameCube stickY +');
  await page.evaluate(() => { window.__pad.axis(0, 0, 0); window.__pad.axis(0, 1, 0); });

  await page.evaluate(() => window.__pad.button(0, 7, 0.6));
  p = await waitPorts(page, (q) => q[0].triggerR > 100, 'analog R');
  check(p && p[0].triggerR >= 140 && p[0].triggerR <= 165 && !p[0].buttons.includes('R'),
    `analog right trigger at 60% -> triggerR ${p && p[0].triggerR}, no digital R yet`);
  await page.evaluate(() => window.__pad.button(0, 7, 1));
  p = await waitPorts(page, (q) => q[0].buttons.includes('R'), 'full R');
  check(p && p[0].triggerR >= 250, 'full right trigger -> R pressed with a full pull');
  await page.evaluate(() => window.__pad.button(0, 6, 1));
  p = await waitPorts(page, (q) => q[0].buttons.includes('L'), 'full L');
  check(!!p, 'left trigger -> L');
  await page.evaluate(() => { window.__pad.button(0, 6, 0); window.__pad.button(0, 7, 0); });
  for (const [b, want] of [[1, 'B'], [2, 'X'], [3, 'Y'], [5, 'Z'], [9, 'Start'], [12, 'Up'], [15, 'Right']]) {
    await page.evaluate((bb) => window.__pad.button(0, bb, 1), b);
    p = await waitPorts(page, (q) => q[0].buttons.includes(want), `pad button ${b}`);
    await page.evaluate((bb) => window.__pad.button(0, bb, 0), b);
    check(!!p, `Xbox button ${b} -> ${want}`);
    await waitPorts(page, (q) => q[0].button === 0, 'release');
  }

  // ---- 3. more pads: ports 2 and 3 --------------------------------------------------------
  await page.evaluate((id) => window.__pad.connect(1, id), DUALSHOCK);
  d = await waitDesc(page, (x) => x.ports[1].pad, 'PS4 pad on port 2');
  check(d && d.ports[1].pad.family === 'playstation' && d.ports[1].pad.type === 'ps4', 'second pad (DualShock 4) -> port 2, PlayStation');
  check(d && layoutMatches(d.ports[1].pad, 'playstation'), 'PlayStation default layout matches the panel');
  check(d && d.ports[0].pad && d.ports[0].pad.family === 'xbox', 'first pad stays on port 1');
  await page.evaluate(() => window.__pad.button(1, 1, 1));
  p = await waitPorts(page, (q) => q[1].buttons.includes('B'), 'circle');
  check(p && p[1].connected && !p[0].buttons.includes('B') && !p[1].keyboard, 'Circle on pad 2 -> B on port 2 only (no keyboard there)');
  await page.evaluate(() => window.__pad.button(1, 1, 0));

  await page.evaluate((id) => window.__pad.connect(2, id), SWITCH_PRO);
  d = await waitDesc(page, (x) => x.ports[2].pad, 'Switch Pro on port 3');
  check(d && d.ports[2].pad.family === 'switch' && d.ports[2].pad.type === 'switchpro', 'third pad (Switch Pro) -> port 3, Switch');
  check(d && layoutMatches(d.ports[2].pad, 'switch'), 'Switch Pro default layout matches the panel');

  // Controls panel lists the pads with their players.
  await page.click('#btn-help');
  const padList = await page.textContent('#pad-list');
  check(/Player 1: .*Xbox layout.*together with the keyboard/.test(padList) && /Player 2: .*PlayStation layout/.test(padList) &&
    /Player 3: .*Switch layout/.test(padList), `Controls panel lists pads, players and layouts`);
  check(/3 gamepads detected/.test(padList), 'Controls panel counts the browser pads');
  check((await page.textContent('#keyboard-source')).includes('read from the game'), 'Controls panel shows the live bindings');
  await page.screenshot({ path: path.join(shotsDir, 'controls-pads.png') });
  await page.click('#btn-help-close');

  // Debug view: raw browser state next to what the game receives.
  await page.evaluate(() => { window.__pad.button(0, 0, 1); window.__pad.axis(0, 0, -0.5); });
  await waitPorts(page, (q) => q[0].buttons.includes('A'), 'debug A');
  // The view redraws on the next animation frame (the harness runs at ~10 fps under SwiftShader).
  await page.waitForFunction(() => /buttons: A\b/.test(document.getElementById('debug-game').textContent), null, { timeout: 3000 }).catch(() => {});
  const raw = await page.textContent('#debug-raw');
  const game = await page.textContent('#debug-game');
  check(raw.includes(XBOX) && /pressed: 0\b/.test(raw) && raw.includes('-0.50'), 'debug view: raw navigator.getGamepads() state');
  check(/P1 {2}keyboard \+ gamepad \(merged\)/.test(game) && /buttons: A\b/.test(game) && /P2 {2}gamepad/.test(game) && /P4 {2}not connected/.test(game),
    `debug view: per-player PADRead state (${JSON.stringify(game)})`);
  await page.screenshot({ path: path.join(shotsDir, 'debug-view.png') });
  await page.evaluate(() => { window.__pad.button(0, 0, 0); window.__pad.axis(0, 0, 0); });

  // ---- 4. rumble through Gamepad.vibrationActuator ----------------------------------------
  await page.evaluate(() => { window.__padEffects.length = 0; window.Module.mkwHarnessMotor = { port: 0, cmd: 1 }; });
  await page.waitForFunction(() => window.__padEffects.some((e) => e.index === 0 && e.strong > 0), null, { timeout: 3000 }).catch(() => {});
  let effects = await page.evaluate(() => window.__padEffects.slice());
  check(effects.some((e) => e.index === 0 && e.type === 'dual-rumble' && e.strong > 0 && e.weak > 0), `PAD_MOTOR_RUMBLE on port 1 -> playEffect on pad 0 (${JSON.stringify(effects[0])})`);
  p = await ports(page);
  check(p[0].motor === 1, 'debug state records the motor command');
  await sleep(2600);
  effects = await page.evaluate(() => window.__padEffects.filter((e) => e.index === 0 && e.strong > 0));
  check(effects.length >= 2, `a held rumble is renewed before the browser's 3 s effect ends (${effects.length} effects in 2.6 s)`);
  await page.evaluate(() => { window.__padEffects.length = 0; window.Module.mkwHarnessMotor = { port: 0, cmd: 0 }; });
  await page.waitForFunction(() => window.__padEffects.some((e) => e.index === 0), null, { timeout: 3000 }).catch(() => {});
  effects = await page.evaluate(() => window.__padEffects.slice());
  check(effects.some((e) => e.index === 0 && (e.type === 'reset' || (e.strong === 0 && e.weak === 0))), `PAD_MOTOR_STOP stops it (${JSON.stringify(effects)})`);
  await page.evaluate(() => { window.__padEffects.length = 0; window.Module.mkwHarnessMotor = { port: 1, cmd: 1 }; });
  await page.waitForFunction(() => window.__padEffects.length > 0, null, { timeout: 3000 }).catch(() => {});
  effects = await page.evaluate(() => window.__padEffects.slice());
  check(effects.length > 0 && effects.every((e) => e.index === 1), 'rumble on port 2 reaches pad 2 only');
  await page.evaluate(() => { window.Module.mkwHarnessMotor = { port: 1, cmd: 2 }; });

  // ---- 5. unplug / replug ----------------------------------------------------------------
  await page.evaluate(() => window.__pad.disconnect(0));
  d = await waitDesc(page, (x) => !x.ports[0].pad, 'port 1 pad gone');
  check(d && d.ports[0].keyboard && d.ports[1].pad && d.ports[1].pad.family === 'playstation' && d.ports[2].pad,
    'unplugging pad 1: port 1 keeps the keyboard, ports 2 and 3 keep their pads');
  p = await waitPorts(page, (q) => q[0].connected && !q[0].controller, 'port 1 keyboard only');
  check(!!p, 'port 1 is still connected (keyboard)');
  await page.evaluate((id) => window.__pad.connect(0, id), XBOX);
  d = await waitDesc(page, (x) => x.ports[0].pad, 'replug');
  check(d && d.ports[0].pad.family === 'xbox' && d.ports[1].pad.family === 'playstation', 'replugging it brings it back to port 1');
  await page.evaluate(() => window.__pad.disconnect(2));
  d = await waitDesc(page, (x) => !x.ports[2].pad, 'switch gone');
  check(!!d, 'unplugging pad 3 frees port 3');

  // ---- 6. a pad without the standard mapping is flagged in the panel ------------------------
  await page.evaluate(() => window.__pad.connect(3, 'Generic USB Joystick (Vendor: 0079 Product: 0006)', ''));
  await sleep(300);
  await page.click('#btn-help');
  check((await page.textContent('#pad-list')).includes('no standard mapping'), 'non-standard pad is flagged in the Controls panel');
  await page.click('#btn-help-close');
  await page.evaluate(() => window.__pad.disconnect(3));

  // ---- 7. ImGui (the F10 settings bar) with the mouse, and F10 itself ----------------------
  await page.mouse.click(700, 650); // outside the ImGui button
  await sleep(300);
  let h = await page.evaluate(() => window.Module.mkwHarness);
  check(h.clicks === 0, `a click beside the ImGui button does not press it (clicks ${h.clicks})`);
  await page.mouse.click(168, 440);
  await page.waitForFunction((n) => window.Module.mkwHarness.clicks > n, h.clicks, { timeout: 3000 }).catch(() => {});
  h = await page.evaluate(() => window.Module.mkwHarness);
  check(h.clicks >= 1, `mouse click on an ImGui button registers (clicks ${h.clicks})`);
  await page.screenshot({ path: path.join(shotsDir, 'imgui-click.png') });
  await page.keyboard.press('F10');
  await page.waitForFunction((n) => window.Module.mkwHarness.f10 > n, h.f10, { timeout: 3000 }).catch(() => {});
  const h2 = await page.evaluate(() => window.Module.mkwHarness);
  check(h2.f10 === h.f10 + 1, `F10 reaches the game as an SDL key event (${h2.f10})`);
  await page.click('#btn-settings');
  await page.waitForFunction((n) => window.Module.mkwHarness.f10 > n, h2.f10, { timeout: 3000 }).catch(() => {});
  const h3 = await page.evaluate(() => window.Module.mkwHarness);
  check(h3.f10 === h2.f10 + 1, `Settings button sends F10 to the game (${h3.f10})`);

  // ---- 8. rebinding persists across a reload ----------------------------------------------
  check(h3.persistent && h3.userPath.startsWith('/home/web_user/'), `bindings live under the IndexedDB-backed $HOME (${h3.userPath}, persistent ${h3.persistent})`);
  await page.evaluate(() => { window.Module.mkwHarnessRebind = { padButton: 0x0100, scancode: 5 /* SDL_SCANCODE_B */ }; });
  d = await waitDesc(page, (x) => x.ports[0].keys.find((k) => k.control === 'A').key === 'B', 'rebind A -> B');
  check(!!d, 'rebinding A to the B key (as the F10 bar does) is reported');
  await page.keyboard.down('KeyB');
  p = await waitPorts(page, (q) => q[0].buttons.includes('A'), 'B key -> A');
  await page.keyboard.up('KeyB');
  check(!!p, 'the new key drives A');
  await page.click('#btn-help');
  const changedRow = await page.$$eval('#keyboard-rows tr.changed', (rows) => rows.map((r) => r.textContent));
  check(changedRow.length === 1 && changedRow[0].includes('B') && changedRow[0].includes('Accelerate'), `Controls panel shows the rebound key (${JSON.stringify(changedRow)})`);
  await page.click('#btn-help-close');
  const fileInfo = await page.evaluate(async () => {
    await window.Module.mkwStorageFlush();
    const path = window.Module.mkwHarness.userPath + '/keyboard_bindings.dat';
    try { return { path, size: window.Module.FS.stat(path).size }; } catch (e) { return { path, error: String(e) }; }
  });
  check(fileInfo.size > 0, `keyboard_bindings.dat written (${JSON.stringify(fileInfo)})`);

  await page.reload();
  await startPage(page);
  d = await waitDesc(page, (x) => x.ports[0].keys.length === 22, 'keys after reload');
  check(d && d.ports[0].keys.find((k) => k.control === 'A').key === 'B', 'after a reload A is still on the B key');
  await page.keyboard.down('KeyB');
  p = await waitPorts(page, (q) => q[0].buttons.includes('A'), 'B after reload');
  await page.keyboard.up('KeyB');
  check(!!p, 'and it still drives A');
  await page.keyboard.down('KeyX');
  await sleep(300);
  p = await ports(page);
  await page.keyboard.up('KeyX');
  check(!p[0].buttons.includes('A'), 'the old key no longer does');
  await page.context().close();

  // ---- 9. HiDPI: ImGui hit-testing with devicePixelRatio 2 ---------------------------------
  {
    const ctx2 = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
    await ctx2.addInitScript(installFakeGamepads);
    const page2 = await ctx2.newPage();
    page2.on('pageerror', (e) => check(false, `page error (DPR 2): ${e.message}`));
    await startPage(page2);
    const c = await page2.evaluate(() => { const x = document.getElementById('canvas'); return [x.width, x.height, x.clientWidth]; });
    await page2.mouse.click(168, 440);
    await page2.waitForFunction(() => window.Module.mkwHarness.clicks > 0, null, { timeout: 3000 }).catch(() => {});
    const clicks = await page2.evaluate(() => window.Module.mkwHarness.clicks);
    check(clicks >= 1, `DPR 2 (canvas ${c[0]}x${c[1]} for ${c[2]} CSS px): ImGui button still hit by the mouse`);
    await page2.screenshot({ path: path.join(shotsDir, 'imgui-dpr2.png') });
    await ctx2.close();
  }
} catch (e) {
  console.log('FAIL unexpected exception: ' + (e && e.stack || e));
  failures++;
}

const bad = consoleLines.filter((l) => /RuntimeError|SuspendError|Aborted\(|unreachable|trying to suspend/i.test(l));
check(bad.length === 0, `no wasm trap / JSPI error in the console${bad.length ? ': ' + bad.join(' | ') : ''}`);
fs.writeFileSync(path.join(shotsDir, 'console.log'), consoleLines.join('\n') + '\n');
console.log(`\nconsole log and screenshots: ${shotsDir}`);
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
server.kill();
process.exit(failures ? 1 : 0);
