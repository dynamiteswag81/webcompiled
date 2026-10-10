// WebCompiled on-screen touch controls for phones and tablets. Plain script, no dependencies.
//
// A floating analog stick on the left, the race buttons on the right (A, B, Drift = R, Item = L,
// Trick = D-pad up) and Start at the top, next to an "Auto A" toggle that keeps A held (accelerate
// without holding a thumb on it). The state goes to the runtime through
// Module.mkwInput.setTouch (web/js/library_mkw_input.js), which merges it into player 1 on every
// PADRead (runtime/src/platform/web/web_input.cpp ApplyTouch), so it works together with the
// keyboard and a gamepad. Nothing here touches the canvas or SDL's own event handling.
//
// Visibility: "auto" (default) shows the controls once the screen is touched (and from the start on
// touch-first devices) and hides them again on keyboard or gamepad use; "always" / "never" force it.
// Settings live in localStorage (per browser) and are edited in the Controls panel.
//
// main.js calls WiiCompiledTouch.attach(Module) when it creates the Module object and
// WiiCompiledTouch.gameStarted() once the runtime is up.
(function () {
  'use strict';

  // GameCube PADStatus.button bits (dolphin/pad.h).
  const PAD = {
    LEFT: 0x0001, RIGHT: 0x0002, DOWN: 0x0004, UP: 0x0008,
    Z: 0x0010, R: 0x0020, L: 0x0040,
    A: 0x0100, B: 0x0200, X: 0x0400, Y: 0x0800, START: 0x1000,
  };

  // The buttons, in the order they are placed (style.css positions them by class).
  const BUTTONS = [
    { id: 'a', bits: PAD.A, label: 'A', title: 'A: accelerate / confirm' },
    { id: 'b', bits: PAD.B, label: 'B', title: 'B: brake, reverse / back' },
    { id: 'r', bits: PAD.R, label: 'Drift', title: 'R: drift / hop', triggerR: true },
    { id: 'l', bits: PAD.L, label: 'Item', title: 'L: use item (hold to drag it behind)', triggerL: true },
    { id: 'trick', bits: PAD.UP, label: 'Trick', title: 'D-pad up: trick off ramps, wheelie on bikes' },
    { id: 'start', bits: PAD.START, label: 'Start', title: 'Start: pause' },
  ];

  const STORAGE_KEY = 'wiicompiled.touch';
  const DEFAULTS = { show: 'auto', size: 100, opacity: 60, haptics: true, fullscreen: true };
  const DEADZONE = 0.12;       // fraction of the stick radius
  const STICK_RADIUS = 56;     // px at size 100%
  const MOTOR_RUMBLE = 1;      // PAD_MOTOR_RUMBLE

  const coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : { matches: false };
  const settings = loadSettings();

  let module = null;
  let running = false;
  let lastInputTouch = coarse.matches || (navigator.maxTouchPoints || 0) > 0 && !hasFinePointer();
  let shown = false;
  let aLatched = false;
  let sent = '';
  let rumbleUntil = 0;
  let rumbling = false;
  let frame = 0;

  // pointerId -> { kind: 'stick', ox, oy } | { kind: 'button', id }
  const pointers = new Map();
  const stick = { x: 0, y: 0 };

  function hasFinePointer() {
    return !!(window.matchMedia && window.matchMedia('(any-pointer: fine)').matches);
  }

  function loadSettings() {
    const s = Object.assign({}, DEFAULTS);
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          if (['auto', 'always', 'never'].includes(saved.show)) s.show = saved.show;
          if (Number.isFinite(saved.size)) s.size = Math.min(140, Math.max(70, saved.size));
          if (Number.isFinite(saved.opacity)) s.opacity = Math.min(100, Math.max(20, saved.opacity));
          if (typeof saved.haptics === 'boolean') s.haptics = saved.haptics;
          if (typeof saved.fullscreen === 'boolean') s.fullscreen = saved.fullscreen;
        }
      }
    } catch (_) { /* private mode, blocked storage: defaults */ }
    return s;
  }

  function saveSettings() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) { /* not saved */ }
  }

  // ---------------------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------------------
  const root = document.createElement('div');
  root.id = 'touch';
  root.className = 'touch';
  root.hidden = true;
  root.setAttribute('aria-hidden', 'true'); // an alternative to the keyboard / gamepad, not page UI

  const zone = document.createElement('div');
  zone.className = 'touch-zone';
  const base = document.createElement('div');
  base.className = 'touch-stick';
  const knob = document.createElement('div');
  knob.className = 'touch-knob';
  base.append(knob);
  zone.append(base);
  root.append(zone);

  const buttonEls = new Map();
  for (const b of BUTTONS) {
    const e = document.createElement('div');
    e.className = 'touch-btn touch-' + b.id;
    e.dataset.btn = b.id;
    e.title = b.title;
    e.textContent = b.label;
    root.append(e);
    buttonEls.set(b.id, e);
  }

  const menu = document.createElement('div');
  menu.className = 'touch-btn touch-menu';
  menu.dataset.action = 'menu';
  menu.title = 'Controls and settings';
  menu.textContent = '☰';
  root.append(menu);

  const latch = document.createElement('div');
  latch.className = 'touch-btn touch-latch';
  latch.dataset.action = 'latch';
  latch.title = 'Keep A held (accelerate without holding it)';
  latch.textContent = 'Auto A';
  root.append(latch);

  function mount() {
    const stage = document.getElementById('stage') || document.body;
    const toolbar = document.getElementById('toolbar');
    stage.insertBefore(root, toolbar || null);
    applyLook();
    bindPanel();
    bindToolbar();
  }

  function applyLook() {
    root.style.setProperty('--touch-scale', String(settings.size / 100));
    root.style.setProperty('--touch-opacity', String(settings.opacity / 100));
  }

  // ---------------------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------------------
  function wanted() {
    if (!running || settings.show === 'never') return false;
    return settings.show === 'always' || lastInputTouch;
  }

  function refresh() {
    const on = wanted();
    if (on !== shown) {
      shown = on;
      root.hidden = !on;
      if (!on) releaseAll();
      document.documentElement.classList.toggle('touch-on', on);
      if (on && !frame) frame = requestAnimationFrame(tick);
    }
    const btn = document.getElementById('btn-touch');
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    // The Controls panel leads with the touch section while the controls are shown; otherwise it
    // sits after the gamepads.
    const help = document.getElementById('touch-help');
    const anchor = on ? document.querySelector('#help .panel-head + .hint') : document.getElementById('rebinding-heading');
    if (help && anchor) {
      if (on) anchor.after(help); else anchor.before(help);
    }
    send();
  }

  // Auto mode: the last kind of input decides.
  window.addEventListener('pointerdown', function (ev) {
    if (ev.pointerType === 'touch' && !lastInputTouch) {
      lastInputTouch = true;
      refresh();
    }
  }, true);
  window.addEventListener('keydown', function (ev) {
    if (!ev.isTrusted || !lastInputTouch || ['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(ev.key)) return;
    // Typing into the Controls panel or the game's settings bar does not count.
    const tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    lastInputTouch = false;
    refresh();
  }, true);
  window.addEventListener('gamepadconnected', function () {
    if (!lastInputTouch) return;
    lastInputTouch = false;
    refresh();
  });

  // ---------------------------------------------------------------------------------------
  // State -> runtime
  // ---------------------------------------------------------------------------------------
  function api() {
    const m = module || window.Module;
    return m && m.mkwInput && typeof m.mkwInput.setTouch === 'function' ? m.mkwInput : null;
  }

  function heldBits() {
    let bits = aLatched ? PAD.A : 0;
    for (const p of pointers.values()) {
      if (p.kind === 'button' && p.id) bits |= BUTTONS.find((b) => b.id === p.id).bits;
    }
    return bits;
  }

  function send() {
    const bits = shown ? heldBits() : 0;
    const state = {
      active: shown,
      button: bits,
      stickX: shown ? stick.x : 0,
      stickY: shown ? stick.y : 0,
      substickX: 0,
      substickY: 0,
      triggerL: bits & PAD.L ? 255 : 0,
      triggerR: bits & PAD.R ? 255 : 0,
    };
    const key = JSON.stringify(state);
    if (key === sent) return;
    const a = api();
    if (a && a.setTouch(state) !== false) sent = key;
    for (const [id, e] of buttonEls) {
      const b = BUTTONS.find((x) => x.id === id);
      e.classList.toggle('held', (bits & b.bits) !== 0);
    }
    buttonEls.get('a').classList.toggle('latched', aLatched);
    latch.classList.toggle('held', aLatched);
  }

  function buzz(ms) {
    if (settings.haptics && navigator.vibrate) {
      try { navigator.vibrate(ms); } catch (_) { /* no vibration motor or not allowed */ }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Pointers
  // ---------------------------------------------------------------------------------------
  function stickRadius() { return STICK_RADIUS * settings.size / 100; }

  function buttonAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const e = hit && hit.closest && hit.closest('.touch-btn[data-btn]');
    return e && root.contains(e) ? e.dataset.btn : null;
  }

  function pressButton(p, id) {
    if (p.id === id) return;
    const before = heldBits();
    p.id = id;
    if (id && (heldBits() & ~before)) buzz(10);
  }

  function placeStick(x, y) {
    // Keep the whole stick on screen.
    const r = stickRadius();
    const zr = zone.getBoundingClientRect();
    const ox = Math.min(Math.max(x, zr.left + r), zr.right - r);
    const oy = Math.min(Math.max(y, zr.top + r), zr.bottom - r);
    base.style.left = (ox - zr.left) + 'px';
    base.style.top = (oy - zr.top) + 'px';
    base.classList.add('active');
    return { ox, oy };
  }

  function moveStick(p, x, y) {
    const r = stickRadius();
    let dx = x - p.ox;
    let dy = y - p.oy;
    const dist = Math.hypot(dx, dy);
    if (dist > r) { dx *= r / dist; dy *= r / dist; }
    knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    const mag = Math.min(1, dist / r);
    const out = mag <= DEADZONE ? 0 : (mag - DEADZONE) / (1 - DEADZONE);
    // Screen y grows downwards; the GameCube stick's up is positive.
    stick.x = dist ? Math.round(dx / Math.min(dist, r) * out * 127) : 0;
    stick.y = dist ? Math.round(-dy / Math.min(dist, r) * out * 127) : 0;
  }

  function resetStick() {
    stick.x = 0;
    stick.y = 0;
    knob.style.transform = '';
    base.style.left = '';
    base.style.top = '';
    base.classList.remove('active');
  }

  function onDown(ev) {
    if (!shown) return;
    const target = ev.target;
    ev.preventDefault();      // no compatibility mouse events, no focus change
    ev.stopPropagation();     // the page toolbar does not pop up for every press
    if (target.closest && target.closest('[data-action="latch"]')) {
      aLatched = !aLatched;
      buzz(aLatched ? 25 : 10);
      send();
      return;
    }
    if (target.closest && target.closest('[data-action="menu"]')) {
      // The page toolbar: Controls (this panel's settings), Touch, Fullscreen, the game's Settings.
      const ui = window.WiiCompiledUI;
      if (ui && typeof ui.showToolbar === 'function') ui.showToolbar();
      return;
    }
    try { target.setPointerCapture(ev.pointerId); } catch (_) { /* synthetic pointer */ }
    if (zone.contains(target)) {
      if ([...pointers.values()].some((p) => p.kind === 'stick')) return;
      const p = Object.assign({ kind: 'stick' }, placeStick(ev.clientX, ev.clientY));
      pointers.set(ev.pointerId, p);
      moveStick(p, ev.clientX, ev.clientY);
    } else {
      const p = { kind: 'button', id: null };
      pointers.set(ev.pointerId, p);
      pressButton(p, buttonAt(ev.clientX, ev.clientY));
    }
    send();
  }

  function onMove(ev) {
    const p = pointers.get(ev.pointerId);
    if (!p) return;
    ev.preventDefault();
    if (p.kind === 'stick') {
      moveStick(p, ev.clientX, ev.clientY);
    } else {
      // Sliding a thumb from one button onto another (A onto Drift, ...) switches to it.
      pressButton(p, buttonAt(ev.clientX, ev.clientY));
    }
    send();
  }

  function onUp(ev) {
    const p = pointers.get(ev.pointerId);
    if (!p) return;
    pointers.delete(ev.pointerId);
    if (p.kind === 'stick') resetStick();
    send();
  }

  function releaseAll() {
    pointers.clear();
    resetStick();
    send();
  }

  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onUp);
  root.addEventListener('lostpointercapture', onUp);
  root.addEventListener('touchstart', (ev) => ev.stopPropagation(), { passive: true });
  root.addEventListener('contextmenu', (ev) => ev.preventDefault());
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  // ---------------------------------------------------------------------------------------
  // Rumble: the game's PADControlMotor on player 1 -> navigator.vibrate, while the touch
  // controls are what player 1 uses (a gamepad on port 1 rumbles itself through SDL).
  // ---------------------------------------------------------------------------------------
  function tick() {
    frame = 0;
    if (!shown) {
      if (rumbling) { buzz(0); rumbling = false; }
      return;
    }
    const a = api();
    const ports = a && typeof a.ports === 'function' ? a.ports() : null;
    const p1 = ports && ports[0];
    const want = !!(p1 && p1.motor === MOTOR_RUMBLE && !p1.controller && settings.haptics);
    const now = performance.now();
    if (want && now > rumbleUntil - 30) {
      buzz(150);
      rumbleUntil = now + 150;
      rumbling = true;
    } else if (!want && rumbling) {
      buzz(0);
      rumbling = false;
    }
    frame = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------------------
  // Fullscreen + landscape on start (touch screens): the start button click is the user gesture
  // both need. Orientation lock only works in fullscreen and is not available everywhere.
  // ---------------------------------------------------------------------------------------
  function goLandscape() {
    const stage = document.getElementById('stage');
    if (!stage || !stage.requestFullscreen || document.fullscreenElement) return;
    stage.requestFullscreen({ navigationUI: 'hide' }).then(function () {
      const o = screen.orientation;
      if (o && typeof o.lock === 'function') o.lock('landscape').catch(() => {});
    }).catch(() => { /* refused: play in the page */ });
  }

  function bindStart() {
    const start = document.getElementById('btn-start');
    if (!start) return;
    start.addEventListener('click', function () {
      if (settings.fullscreen && settings.show !== 'never' && lastInputTouch) goLandscape();
    });
  }

  // ---------------------------------------------------------------------------------------
  // Controls panel settings and the toolbar toggle
  // ---------------------------------------------------------------------------------------
  function bindPanel() {
    const show = document.getElementById('touch-show');
    const size = document.getElementById('touch-size');
    const opacity = document.getElementById('touch-opacity');
    const haptics = document.getElementById('touch-haptics');
    const fullscreen = document.getElementById('touch-fullscreen');
    if (show) {
      show.value = settings.show;
      show.addEventListener('change', () => { settings.show = show.value; saveSettings(); refresh(); });
    }
    if (size) {
      size.value = String(settings.size);
      size.addEventListener('input', () => { settings.size = Number(size.value); saveSettings(); applyLook(); });
    }
    if (opacity) {
      opacity.value = String(settings.opacity);
      opacity.addEventListener('input', () => { settings.opacity = Number(opacity.value); saveSettings(); applyLook(); });
    }
    if (haptics) {
      haptics.checked = settings.haptics;
      haptics.addEventListener('change', () => { settings.haptics = haptics.checked; saveSettings(); });
    }
    if (fullscreen) {
      fullscreen.checked = settings.fullscreen;
      fullscreen.addEventListener('change', () => { settings.fullscreen = fullscreen.checked; saveSettings(); });
    }
  }

  function bindToolbar() {
    const btn = document.getElementById('btn-touch');
    if (!btn) return;
    // Only where there is a touch screen (or the controls were forced on).
    btn.hidden = !((navigator.maxTouchPoints || 0) > 0 || coarse.matches || settings.show === 'always');
    btn.addEventListener('click', function () {
      settings.show = shown ? 'never' : 'always';
      saveSettings();
      const show = document.getElementById('touch-show');
      if (show) show.value = settings.show;
      refresh();
    });
  }

  // ---------------------------------------------------------------------------------------
  // Hooks for main.js, tests and the console
  // ---------------------------------------------------------------------------------------
  window.WiiCompiledTouch = {
    attach: function (m) {
      module = m;
      const previous = m.onMkwInputReady;
      m.onMkwInputReady = function () {
        if (typeof previous === 'function') previous();
        sent = '';
        send();
      };
    },
    gameStarted: function () {
      running = true;
      refresh();
    },
    settings: function () { return Object.assign({}, settings); },
    state: function () { return { shown, latched: aLatched, buttons: heldBits(), stickX: stick.x, stickY: stick.y }; },
    PAD,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount(); bindStart(); });
  } else {
    mount();
    bindStart();
  }
})();
