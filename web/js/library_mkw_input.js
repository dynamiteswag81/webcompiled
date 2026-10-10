// Input glue for the WebAssembly build of WiiCompiled, linked with --js-library.
// C++ side: runtime/src/platform/web/web_input.cpp (runtime/include/web_input.h).
//
// Gamepads and the keyboard reach the game through SDL3's Emscripten backend (navigator.
// getGamepads(), polled on the main loop; gamepadconnected / gamepaddisconnected for hot-plug;
// Gamepad.vibrationActuator for rumble). This library adds no input path of its own: it only
// lets the page see what the game receives, plus one way in for the page's on-screen touch
// controls (web/site/touch.js), which the runtime merges into player 1 (WebInput::ApplyTouch).
//
// Module helpers installed here (all cheap, safe to call every animation frame):
//   Module.mkwInput.ports()       -> null before the game's first PADRead, else an array of 4
//                                    {port, err, connected, button, buttons[], stickX, stickY,
//                                     substickX, substickY, triggerL, triggerR, motor,
//                                     keyboard, controller, merged}
//                                    read straight from the snapshot in wasm memory
//   Module.mkwInput.reads()       -> number of guest PADRead calls so far
//   Module.mkwInput.description() -> last port description (keyboard keys, pad name / type /
//                                    layout per port), see web_input.cpp Describe()
//   Module.mkwInput.setTouch(t)   -> the touch controls' state, read on the game's next PADRead:
//                                    {active, button (PAD_* bits), stickX, stickY, substickX,
//                                     substickY (-127..127, up positive), triggerL, triggerR (0..255)}
//                                    false before the runtime attached (nothing is written)
// Module callbacks (optional, called asynchronously, never from inside wasm):
//   Module.onMkwInputChanged(description)  ports or bindings changed
//   Module.onMkwInputReady()               the runtime attached; setTouch works from now on

addToLibrary({
  $MkwInput__postset: 'MkwInput.install();',
  $MkwInput: {
    state: 0,
    size: 0,
    touch: 0,
    desc: null,

    // GameCube PADStatus.button bits, in the order the debug view prints them.
    BUTTONS: [
      ['A', 0x0100], ['B', 0x0200], ['X', 0x0400], ['Y', 0x0800], ['Start', 0x1000],
      ['Z', 0x0010], ['L', 0x0040], ['R', 0x0020],
      ['Up', 0x0008], ['Down', 0x0004], ['Left', 0x0001], ['Right', 0x0002],
    ],

    install() {
      Module['mkwInput'] = {
        'ports': () => MkwInput.ports(),
        'reads': () => MkwInput.state ? HEAPU32[(MkwInput.state + 4) >> 2] : 0,
        'description': () => MkwInput.desc,
        'buttonNames': (bits) => MkwInput.buttonNames(bits),
        'setTouch': (t) => MkwInput.setTouch(t),
      };
    },

    // Layout: web_input.cpp TouchState (12 bytes).
    setTouch(t) {
      const p = MkwInput.touch;
      if (!p || !t) return false;
      const axis = (v) => Math.max(-127, Math.min(127, Math.round(v || 0)));
      const trigger = (v) => Math.max(0, Math.min(255, Math.round(v || 0)));
      HEAPU32[p >> 2] = t['active'] ? 1 : 0;
      HEAPU16[(p + 4) >> 1] = (t['button'] || 0) & 0xFFFF;
      HEAP8[p + 6] = axis(t['stickX']);
      HEAP8[p + 7] = axis(t['stickY']);
      HEAP8[p + 8] = axis(t['substickX']);
      HEAP8[p + 9] = axis(t['substickY']);
      HEAPU8[p + 10] = trigger(t['triggerL']);
      HEAPU8[p + 11] = trigger(t['triggerR']);
      return true;
    },

    buttonNames(bits) {
      return MkwInput.BUTTONS.filter(([, bit]) => (bits & bit) != 0).map(([name]) => name);
    },

    // Layout: web_input.cpp State / PortState (16-byte header, 12 bytes per port).
    ports() {
      const base = MkwInput.state;
      if (!base || HEAPU32[(base + 4) >> 2] == 0) return null;
      const out = [];
      for (let port = 0; port < 4; ++port) {
        const p = base + 16 + port * 12;
        const button = HEAPU8[p] | (HEAPU8[p + 1] << 8);
        const err = HEAP8[p + 8];
        const flags = HEAPU8[p + 10];
        out.push({
          'port': port + 1,
          'err': err,
          'connected': err == 0,
          'button': button,
          'buttons': MkwInput.buttonNames(button),
          'stickX': HEAP8[p + 2],
          'stickY': HEAP8[p + 3],
          'substickX': HEAP8[p + 4],
          'substickY': HEAP8[p + 5],
          'triggerL': HEAPU8[p + 6],
          'triggerR': HEAPU8[p + 7],
          'motor': HEAPU8[p + 9] == 0xFF ? null : HEAPU8[p + 9],
          'keyboard': (flags & 1) != 0,
          'controller': (flags & 2) != 0,
          'merged': (flags & 4) != 0,
          'touch': (flags & 8) != 0,
        });
      }
      return out;
    },
  },

  // Called once from WebInput::Initialize (main, before the game starts).
  mkw_input_attach__deps: ['$MkwInput'],
  mkw_input_attach: (state, size, touch) => {
    MkwInput.state = state;
    MkwInput.size = size;
    MkwInput.touch = touch;
    const ready = Module['onMkwInputReady'];
    if (typeof ready == 'function') setTimeout(() => ready(), 0);
  },

  // Called from the guest's PADRead path when the description changed: parse and hand it to the
  // page on a later task so no page code runs while the guest is on the stack.
  mkw_input_describe__deps: ['$MkwInput', '$UTF8ToString'],
  mkw_input_describe: (json) => {
    let desc;
    try {
      desc = JSON.parse(UTF8ToString(json));
    } catch (e) {
      err(`[input] bad port description: ${e && e.message || e}`);
      return;
    }
    MkwInput.desc = desc;
    const notify = Module['onMkwInputChanged'];
    if (typeof notify == 'function') {
      setTimeout(() => {
        try {
          notify(desc);
        } catch (e) {
          err(`[input] onMkwInputChanged failed: ${e && e.message || e}`);
        }
      }, 0);
    }
  },
});
