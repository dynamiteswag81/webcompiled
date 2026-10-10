#pragma once

// The keyboard layout port 1 gets in the browser with no setup (web build only; native builds
// keep aurora's "no keyboard until enabled in F10" default). It is merged with any gamepad on
// port 1. This table is the single source of truth: runtime/src/platform/web/web_input.cpp
// installs it, and the page's Controls panel mirrors it (web/site/main.js KEYBOARD_LAYOUT);
// web/tests/input/pad_merge_test.cpp --layout-json prints it and run_input_test.sh checks that
// the page's copy agrees. Rebinding happens in the F10 settings bar and is saved under $HOME
// (keyboard_bindings.dat, IndexedDB-backed on the web).
//
// GameCube pad semantics for Mario Kart Wii: A accelerates, B brakes, R drifts/hops, L uses the
// item, the D-pad does tricks and wheelies.

#include <array>
#include <cstdint>

#include <SDL3/SDL_scancode.h>
#include <dolphin/pad.h>

namespace WebInputLayout {

struct KeyBinding {
    const char* control;  // GameCube control as the Controls panel names it
    bool axis;            // true: padCode is a PAD_AXIS_*, false: a PAD_BUTTON_* / PAD_TRIGGER_* bit
    uint16_t padCode;
    int32_t scancode;     // SDL scancode (physical key position)
    const char* code;     // the matching KeyboardEvent.code
    const char* key;      // what the panel prints on the key cap
    const char* sdlName;  // SDL_GetScancodeName(scancode): how the game names the key (live bindings)
    const char* action;   // what it does in Mario Kart Wii ("" when the game gives it no fixed job)
};

inline constexpr std::array<KeyBinding, 22> kKeyboard = {{
    {"Stick right", true, PAD_AXIS_LEFT_X_POS, SDL_SCANCODE_RIGHT, "ArrowRight", "→", "Right", "Steer / menus"},
    {"Stick left", true, PAD_AXIS_LEFT_X_NEG, SDL_SCANCODE_LEFT, "ArrowLeft", "←", "Left", "Steer / menus"},
    {"Stick up", true, PAD_AXIS_LEFT_Y_POS, SDL_SCANCODE_UP, "ArrowUp", "↑", "Up", "Menus"},
    {"Stick down", true, PAD_AXIS_LEFT_Y_NEG, SDL_SCANCODE_DOWN, "ArrowDown", "↓", "Down", "Menus"},
    {"A", false, PAD_BUTTON_A, SDL_SCANCODE_X, "KeyX", "X", "X", "Accelerate / confirm"},
    {"B", false, PAD_BUTTON_B, SDL_SCANCODE_Z, "KeyZ", "Z", "Z", "Brake, reverse / back"},
    {"R", false, PAD_TRIGGER_R, SDL_SCANCODE_LSHIFT, "ShiftLeft", "Shift", "Left Shift", "Drift / hop"},
    {"R analog", true, PAD_AXIS_TRIGGER_R, SDL_SCANCODE_LSHIFT, "ShiftLeft", "Shift", "Left Shift", "Drift / hop"},
    {"L", false, PAD_TRIGGER_L, SDL_SCANCODE_SPACE, "Space", "Space", "Space", "Use item"},
    {"L analog", true, PAD_AXIS_TRIGGER_L, SDL_SCANCODE_SPACE, "Space", "Space", "Space", "Use item"},
    {"Start", false, PAD_BUTTON_START, SDL_SCANCODE_RETURN, "Enter", "Enter", "Return", "Pause"},
    {"X", false, PAD_BUTTON_X, SDL_SCANCODE_C, "KeyC", "C", "C", ""},
    {"Y", false, PAD_BUTTON_Y, SDL_SCANCODE_V, "KeyV", "V", "V", ""},
    {"Z", false, PAD_TRIGGER_Z, SDL_SCANCODE_Q, "KeyQ", "Q", "Q", ""},
    {"C-stick up", true, PAD_AXIS_RIGHT_Y_POS, SDL_SCANCODE_I, "KeyI", "I", "I", ""},
    {"C-stick left", true, PAD_AXIS_RIGHT_X_NEG, SDL_SCANCODE_J, "KeyJ", "J", "J", ""},
    {"C-stick down", true, PAD_AXIS_RIGHT_Y_NEG, SDL_SCANCODE_K, "KeyK", "K", "K", ""},
    {"C-stick right", true, PAD_AXIS_RIGHT_X_POS, SDL_SCANCODE_L, "KeyL", "L", "L", ""},
    {"D-pad up", false, PAD_BUTTON_UP, SDL_SCANCODE_W, "KeyW", "W", "W", "Tricks / wheelie"},
    {"D-pad left", false, PAD_BUTTON_LEFT, SDL_SCANCODE_A, "KeyA", "A", "A", "Tricks / wheelie"},
    {"D-pad down", false, PAD_BUTTON_DOWN, SDL_SCANCODE_S, "KeyS", "S", "S", "Tricks / wheelie"},
    {"D-pad right", false, PAD_BUTTON_RIGHT, SDL_SCANCODE_D, "KeyD", "D", "D", "Tricks / wheelie"},
}};

// Every GameCube button and every stick/trigger direction aurora knows has exactly one key.
inline constexpr size_t kButtonCount = 12;
inline constexpr size_t kAxisCount = 10;
static_assert(kButtonCount == PAD_BUTTON_COUNT && kAxisCount == PAD_AXIS_COUNT);
static_assert(kKeyboard.size() == kButtonCount + kAxisCount);

// Fills aurora's binding arrays (PADSetDefaultKeyBindings input) from the table.
inline void Fill(std::array<PADKeyButtonBinding, PAD_BUTTON_COUNT>& buttons,
                 std::array<PADKeyAxisBinding, PAD_AXIS_COUNT>& axes) {
    size_t b = 0;
    size_t a = 0;
    for (const KeyBinding& entry : kKeyboard) {
        if (entry.axis) {
            if (a < axes.size()) {
                axes[a++] = PADKeyAxisBinding{entry.scancode, entry.padCode, 1};
            }
        } else if (b < buttons.size()) {
            buttons[b++] = PADKeyButtonBinding{entry.scancode, entry.padCode};
        }
    }
}

} // namespace WebInputLayout
