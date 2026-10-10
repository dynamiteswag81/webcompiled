// [web] Browser input glue; see runtime/include/web_input.h.
//
// The game sees whatever aurora's PADRead returns. In the browser that is SDL3's Emscripten
// joystick backend (navigator.getGamepads(), polled in SDL_PumpEvents on the main loop, hot-plug
// through gamepadconnected / gamepaddisconnected) plus SDL's keyboard state. This file only:
//   * installs the default keyboard layout on port 1 and turns on keyboard + gamepad merging
//     (aurora PADSetDefaultKeyBindings / PADSetKeyboardMergesController), so the keyboard works
//     with no setup and a gamepad on port 1 does not need a setting change;
//   * keeps a 64-byte snapshot of the statuses the game received, which the page reads straight
//     out of wasm memory (web/js/library_mkw_input.js) for its input debug view;
//   * merges the page's on-screen touch controls (web/site/touch.js) into port 1: the page writes
//     the held buttons and stick positions into a small block of wasm memory (TouchState) and
//     ApplyTouch reads it on every PADRead;
//   * sends the page a JSON description of the ports (keyboard keys, pad name / type / layout)
//     whenever it changes, for the Controls panel.
// None of it runs from a JS callback: everything is called from the guest's PADRead path or main.

#include "web_input.h"

#include "controller_button_names.h"
#include "web_input_layout.h"

#include <SDL3/SDL_gamepad.h>
#include <SDL3/SDL_keyboard.h>

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

extern "C" {
// web/js/library_mkw_input.js
void mkw_input_attach(void* state, uint32_t size, void* touch);
void mkw_input_describe(const char* json);
}

namespace WebInput {
namespace {

// Read by library_mkw_input.js (MkwInput.decode): keep the layout in sync with it.
struct PortState {
    uint16_t button;
    int8_t stickX;
    int8_t stickY;
    int8_t substickX;
    int8_t substickY;
    uint8_t triggerL;
    uint8_t triggerR;
    int8_t err;
    uint8_t motor;  // last PADControlMotor command, 0xFF before any
    uint8_t flags;  // kFlag*
    uint8_t reserved;
};
static_assert(sizeof(PortState) == 12);

struct State {
    uint32_t magic;      // 'MKWI'
    uint32_t reads;      // guest PADRead calls so far
    uint32_t rumbleMask; // PADRead's return value
    uint32_t reserved;
    PortState ports[PAD_CHANMAX];
};
static_assert(sizeof(State) == 16 + 12 * PAD_CHANMAX);

// Written by the page (library_mkw_input.js MkwInput.setTouch), read by ApplyTouch: keep the
// layout in sync with it.
struct TouchState {
    uint32_t active;   // nonzero while the on-screen controls are shown
    uint16_t button;   // PAD_BUTTON_* / PAD_TRIGGER_* bits held
    int8_t stickX;     // -127..127, up positive (GameCube convention)
    int8_t stickY;
    int8_t substickX;
    int8_t substickY;
    uint8_t triggerL;  // 0..255
    uint8_t triggerR;
};
static_assert(sizeof(TouchState) == 12);

enum : uint8_t {
    kFlagKeyboard = 1,    // keyboard bindings active on the port
    kFlagController = 2,  // a gamepad is assigned to the port
    kFlagMerged = 4,      // keyboard and gamepad are merged (not replacing each other)
    kFlagTouch = 8,       // the on-screen touch controls are shown and feed the port
};

State g_state{};
TouchState g_touch{};
bool g_initialized = false;
std::vector<int32_t> g_lastSignature;

const char* PadTypeName(PADControllerType type) {
    switch (type) {
    case PAD_TYPE_STANDARD: return "standard";
    case PAD_TYPE_XBOX360: return "xbox360";
    case PAD_TYPE_XBOXONE: return "xboxone";
    case PAD_TYPE_PS3: return "ps3";
    case PAD_TYPE_PS4: return "ps4";
    case PAD_TYPE_PS5: return "ps5";
    case PAD_TYPE_SWITCH_PROCON: return "switchpro";
    case PAD_TYPE_JOYCON_LEFT: return "joyconleft";
    case PAD_TYPE_JOYCON_RIGHT: return "joyconright";
    case PAD_TYPE_JOYCON_PAIR: return "joyconpair";
    case PAD_TYPE_GAMECUBE: return "gamecube";
    case PAD_TYPE_NSO_GAMECUBE: return "nsogamecube";
    default: return "unknown";
    }
}

// Which printed labels the Controls panel uses: the browser's "standard" mapping is the Xbox
// layout, so unknown pads read like an Xbox pad.
const char* PadFamily(PADControllerType type) {
    switch (type) {
    case PAD_TYPE_PS3:
    case PAD_TYPE_PS4:
    case PAD_TYPE_PS5: return "playstation";
    case PAD_TYPE_SWITCH_PROCON:
    case PAD_TYPE_JOYCON_LEFT:
    case PAD_TYPE_JOYCON_RIGHT:
    case PAD_TYPE_JOYCON_PAIR: return "switch";
    case PAD_TYPE_GAMECUBE:
    case PAD_TYPE_NSO_GAMECUBE: return "gamecube";
    default: return "xbox";
    }
}

// The printed name of a native input on a pad of the given family (positional SDL names map to
// whatever is printed at that position).
std::string NativeLabel(const std::string& family, uint32_t native, uint16_t padButton) {
    const int f = family == "playstation" ? 1 : family == "switch" ? 2 : 0;
    const auto pick = [f](const char* xbox, const char* ps, const char* sw) {
        return std::string(f == 1 ? ps : f == 2 ? sw : xbox);
    };
    if (native == PAD_NATIVE_BUTTON_INVALID) {
        // aurora drives L/R from the analog triggers when no button is bound.
        if (padButton == PAD_TRIGGER_L) return pick("LT", "L2", "ZL");
        if (padButton == PAD_TRIGGER_R) return pick("RT", "R2", "ZR");
        return "";
    }
    if (native == PAD_NATIVE_BUTTON_DISABLED) {
        return "";
    }
    if (PADIsAxisButton(native)) {
        const uint32_t axis = PADAxisButtonAxis(native);
        if (axis == SDL_GAMEPAD_AXIS_LEFT_TRIGGER) return pick("LT", "L2", "ZL");
        if (axis == SDL_GAMEPAD_AXIS_RIGHT_TRIGGER) return pick("RT", "R2", "ZR");
        return ControllerNames::NativeButtonForValue(native).label;
    }
    switch (native) {
    case SDL_GAMEPAD_BUTTON_SOUTH: return pick("A", "Cross", "B");
    case SDL_GAMEPAD_BUTTON_EAST: return pick("B", "Circle", "A");
    case SDL_GAMEPAD_BUTTON_WEST: return pick("X", "Square", "Y");
    case SDL_GAMEPAD_BUTTON_NORTH: return pick("Y", "Triangle", "X");
    case SDL_GAMEPAD_BUTTON_START: return pick("Menu", "Options", "+");
    case SDL_GAMEPAD_BUTTON_BACK: return pick("View", "Create", "−");
    case SDL_GAMEPAD_BUTTON_LEFT_SHOULDER: return pick("LB", "L1", "L");
    case SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER: return pick("RB", "R1", "R");
    case SDL_GAMEPAD_BUTTON_LEFT_STICK: return pick("LS click", "L3", "L-stick click");
    case SDL_GAMEPAD_BUTTON_RIGHT_STICK: return pick("RS click", "R3", "R-stick click");
    case SDL_GAMEPAD_BUTTON_GUIDE: return pick("Xbox", "PS", "Home");
    case SDL_GAMEPAD_BUTTON_DPAD_UP: return "D-pad up";
    case SDL_GAMEPAD_BUTTON_DPAD_DOWN: return "D-pad down";
    case SDL_GAMEPAD_BUTTON_DPAD_LEFT: return "D-pad left";
    case SDL_GAMEPAD_BUTTON_DPAD_RIGHT: return "D-pad right";
    default: return ControllerNames::NativeButtonForValue(native).label;
    }
}

std::string KeyLabel(int32_t scancode) {
    switch (scancode) {
    case PAD_KEY_INVALID: return "";
    case PAD_KEY_MOUSE_LEFT: return "Mouse left";
    case PAD_KEY_MOUSE_RIGHT: return "Mouse right";
    case PAD_KEY_MOUSE_MIDDLE: return "Mouse middle";
    case PAD_KEY_MOUSE_X1: return "Mouse side 1";
    case PAD_KEY_MOUSE_X2: return "Mouse side 2";
    default: break;
    }
    if (scancode < 0 || scancode >= SDL_SCANCODE_COUNT) {
        return "?";
    }
    const char* name = SDL_GetScancodeName(static_cast<SDL_Scancode>(scancode));
    return name != nullptr && *name != '\0' ? name : "?";
}

const char* ControlName(bool axis, uint16_t padCode) {
    for (const auto& entry : WebInputLayout::kKeyboard) {
        if (entry.axis == axis && entry.padCode == padCode) {
            return entry.control;
        }
    }
    return "?";
}

void AppendJsonString(std::string& out, const std::string& text) {
    out += '"';
    for (const unsigned char c : text) {
        if (c == '"' || c == '\\') {
            out += '\\';
            out += static_cast<char>(c);
        } else if (c < 0x20) {
            char buffer[8];
            std::snprintf(buffer, sizeof(buffer), "\\u%04x", c);
            out += buffer;
        } else {
            out += static_cast<char>(c);
        }
    }
    out += '"';
}

// Everything the description depends on, so it is rebuilt only when something changed.
std::vector<int32_t> Signature() {
    std::vector<int32_t> signature;
    signature.reserve(4 * 40);
    signature.push_back(PADGetKeyboardMergesController());
    for (uint32_t port = 0; port < PAD_CHANMAX; ++port) {
        const bool keyboard = PADIsKeyboardActive(port) != FALSE;
        signature.push_back(keyboard);
        if (keyboard) {
            u32 count = 0;
            if (const PADKeyButtonBinding* keys = PADGetKeyButtonBindings(port, &count)) {
                for (u32 i = 0; i < count; ++i) signature.push_back(keys[i].scancode);
            }
            count = 0;
            if (const PADKeyAxisBinding* axes = PADGetKeyAxisBindings(port, &count)) {
                for (u32 i = 0; i < count; ++i) signature.push_back(axes[i].scancode);
            }
        }
        const s32 index = PADGetIndexForPort(port);
        signature.push_back(index);
        if (index >= 0) {
            SDL_Gamepad* gamepad = PADGetSDLGamepadForIndex(static_cast<u32>(index));
            signature.push_back(gamepad != nullptr ? static_cast<int32_t>(SDL_GetGamepadID(gamepad)) : -1);
            u32 count = 0;
            if (const PADButtonMapping* mappings = PADGetButtonMappings(port, &count)) {
                for (u32 i = 0; i < count; ++i) signature.push_back(static_cast<int32_t>(mappings[i].nativeButton));
            }
        }
    }
    return signature;
}

std::string Describe() {
    std::string json = "{\"merge\":";
    json += PADGetKeyboardMergesController() ? "true" : "false";
    json += ",\"ports\":[";
    for (uint32_t port = 0; port < PAD_CHANMAX; ++port) {
        if (port != 0) json += ',';
        json += "{\"port\":" + std::to_string(port + 1);
        const bool keyboard = PADIsKeyboardActive(port) != FALSE;
        json += ",\"keyboard\":";
        json += keyboard ? "true" : "false";
        json += ",\"keys\":[";
        if (keyboard) {
            bool first = true;
            const auto add = [&](bool axis, uint16_t padCode, int32_t scancode) {
                if (!first) json += ',';
                first = false;
                json += "{\"control\":";
                AppendJsonString(json, ControlName(axis, padCode));
                json += ",\"key\":";
                AppendJsonString(json, KeyLabel(scancode));
                json += '}';
            };
            u32 count = 0;
            if (const PADKeyButtonBinding* keys = PADGetKeyButtonBindings(port, &count)) {
                for (u32 i = 0; i < count; ++i) add(false, keys[i].padButton, keys[i].scancode);
            }
            count = 0;
            if (const PADKeyAxisBinding* axes = PADGetKeyAxisBindings(port, &count)) {
                for (u32 i = 0; i < count; ++i) add(true, axes[i].padAxis, axes[i].scancode);
            }
        }
        json += "],\"pad\":";
        const s32 index = PADGetIndexForPort(port);
        if (index < 0) {
            json += "null}";
            continue;
        }
        const PADControllerType type = PADGetControllerTypeForIndex(static_cast<u32>(index));
        const std::string family = PadFamily(type);
        const char* name = PADGetNameForControllerIndex(static_cast<u32>(index));
        json += "{\"name\":";
        AppendJsonString(json, name != nullptr ? name : "");
        json += ",\"type\":";
        AppendJsonString(json, PadTypeName(type));
        json += ",\"family\":";
        AppendJsonString(json, family);
        json += ",\"buttons\":[";
        u32 count = 0;
        const PADButtonMapping* mappings = PADGetButtonMappings(port, &count);
        for (size_t i = 0; mappings != nullptr && i < ControllerNames::kGameCubeButtons.size(); ++i) {
            const auto& gc = ControllerNames::kGameCubeButtons[i];
            uint32_t native = PAD_NATIVE_BUTTON_DISABLED;
            for (u32 m = 0; m < count; ++m) {
                if (mappings[m].padButton == gc.padButton) native = mappings[m].nativeButton;
            }
            if (i != 0) json += ',';
            json += "{\"control\":";
            AppendJsonString(json, gc.label);
            json += ",\"input\":";
            AppendJsonString(json, NativeLabel(family, native, gc.padButton));
            json += '}';
        }
        json += "]}}";
    }
    json += "]}";
    return json;
}

void RefreshDescription(bool force) {
    std::vector<int32_t> signature = Signature();
    if (!force && signature == g_lastSignature) {
        return;
    }
    g_lastSignature = std::move(signature);
    mkw_input_describe(Describe().c_str());
}

} // namespace

void Initialize() noexcept {
    if (g_initialized) {
        return;
    }
    g_initialized = true;
    std::array<PADKeyButtonBinding, PAD_BUTTON_COUNT> buttons{};
    std::array<PADKeyAxisBinding, PAD_AXIS_COUNT> axes{};
    WebInputLayout::Fill(buttons, axes);
    PADSetDefaultKeyBindings(0, buttons.data(), static_cast<u32>(buttons.size()), axes.data(),
                             static_cast<u32>(axes.size()), TRUE);
    PADSetKeyboardMergesController(TRUE);

    g_state.magic = 0x4D4B5749;  // 'MKWI'
    for (auto& port : g_state.ports) {
        port.err = PAD_ERR_NO_CONTROLLER;
        port.motor = 0xFF;
    }
    mkw_input_attach(&g_state, sizeof(g_state), &g_touch);
}

void PublishPadStatus(const PADStatus* statuses, uint32_t count, uint32_t rumbleMask) noexcept {
    if (!g_initialized || statuses == nullptr) {
        return;
    }
    ++g_state.reads;
    g_state.rumbleMask = rumbleMask;
    const bool merge = PADGetKeyboardMergesController() != FALSE;
    for (uint32_t port = 0; port < PAD_CHANMAX && port < count; ++port) {
        const PADStatus& status = statuses[port];
        PortState& out = g_state.ports[port];
        out.button = status.button;
        out.stickX = status.stickX;
        out.stickY = status.stickY;
        out.substickX = status.substickX;
        out.substickY = status.substickY;
        out.triggerL = status.triggerLeft;
        out.triggerR = status.triggerRight;
        out.err = status.err;
        const bool keyboard = PADIsKeyboardActive(port) != FALSE;
        const bool controller = PADGetIndexForPort(port) >= 0;
        const bool touch = port == 0 && g_touch.active != 0;
        out.flags = static_cast<uint8_t>((keyboard ? kFlagKeyboard : 0) | (controller ? kFlagController : 0) |
                                         (keyboard && controller && merge ? kFlagMerged : 0) |
                                         (touch ? kFlagTouch : 0));
    }
    RefreshDescription(false);
}

void ApplyTouch(PADStatus* statuses, uint32_t count) noexcept {
    if (!g_initialized || statuses == nullptr || count == 0 || g_touch.active == 0) {
        return;
    }
    // Whichever source is pushed further wins, per axis, so a gamepad or the keyboard still
    // works while the touch controls are shown.
    const auto stronger = [](int8_t a, int8_t b) {
        return static_cast<int8_t>(std::abs(int(b)) > std::abs(int(a)) ? b : a);
    };
    PADStatus& status = statuses[0];
    if (status.err != PAD_ERR_NONE) {
        // Nothing else on port 1 (keyboard turned off in F10, no gamepad): the touch controls
        // are the controller.
        status = PADStatus{};
        status.err = PAD_ERR_NONE;
    }
    status.button |= g_touch.button;
    status.stickX = stronger(status.stickX, g_touch.stickX);
    status.stickY = stronger(status.stickY, g_touch.stickY);
    status.substickX = stronger(status.substickX, g_touch.substickX);
    status.substickY = stronger(status.substickY, g_touch.substickY);
    status.triggerLeft = std::max(status.triggerLeft, g_touch.triggerL);
    status.triggerRight = std::max(status.triggerRight, g_touch.triggerR);
    if ((g_touch.button & PAD_BUTTON_A) != 0) status.analogA = 0xFF;
    if ((g_touch.button & PAD_BUTTON_B) != 0) status.analogB = 0xFF;
}

void NoteMotor(uint32_t port, uint32_t command) noexcept {
    if (port < PAD_CHANMAX) {
        g_state.ports[port].motor = static_cast<uint8_t>(command);
    }
}

} // namespace WebInput
