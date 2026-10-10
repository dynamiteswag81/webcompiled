// Native unit test for the web keyboard layout and the keyboard + gamepad merge.
//
//   c++ -std=c++20 -DTARGET_PC -Iaurora-main/include -Iaurora-main/lib -Iruntime/include \
//       -I<SDL3 include dir> web/tests/input/pad_merge_test.cpp -o pad_merge_test
//   ./pad_merge_test                 # runs the checks, prints PASS/FAIL lines, exit 0 on success
//   ./pad_merge_test --layout-json   # prints runtime/include/web_input_layout.h as JSON
//                                    # (run_input_test.sh compares it with web/site/main.js)
//
// Covers aurora::pad::keyboard_status / merge_status (aurora-main/lib/dolphin/pad/pad_merge.hpp,
// what PADRead runs) and WebInputLayout (runtime/include/web_input_layout.h, what the web build
// installs on port 1). Header-only on purpose: no SDL library, window or controller needed.

#include "dolphin/pad/pad_merge.hpp"
#include "web_input_layout.h"

#include <cstdio>
#include <cstring>
#include <set>
#include <string>
#include <utility>

namespace {

int g_failures = 0;

void Check(bool ok, const std::string& what) {
    std::printf("%s %s\n", ok ? "PASS" : "FAIL", what.c_str());
    if (!ok) ++g_failures;
}

struct Layout {
    std::array<PADKeyButtonBinding, PAD_BUTTON_COUNT> buttons{};
    std::array<PADKeyAxisBinding, PAD_AXIS_COUNT> axes{};
    Layout() { WebInputLayout::Fill(buttons, axes); }

    // Status for a set of held scancodes.
    PADStatus Press(std::set<int32_t> held) const {
        return aurora::pad::keyboard_status(buttons.data(), buttons.size(), axes.data(), axes.size(),
                                            [&held](int32_t scancode) { return held.count(scancode) != 0; });
    }
};

const WebInputLayout::KeyBinding* Find(const char* control) {
    for (const auto& entry : WebInputLayout::kKeyboard) {
        if (std::strcmp(entry.control, control) == 0) return &entry;
    }
    return nullptr;
}

void TestLayoutShape() {
    std::set<uint16_t> buttons;
    std::set<uint16_t> axes;
    for (const auto& entry : WebInputLayout::kKeyboard) {
        (entry.axis ? axes : buttons).insert(entry.padCode);
        Check(entry.scancode > 0 && entry.scancode < SDL_SCANCODE_COUNT,
              std::string("layout: ") + entry.control + " has a real key");
    }
    Check(buttons.size() == PAD_BUTTON_COUNT, "layout: every GameCube button has exactly one key");
    Check(axes.size() == PAD_AXIS_COUNT, "layout: every stick / trigger direction has exactly one key");

    // A key drives one control, except L/R which press the digital button and pull the trigger.
    bool unique = true;
    for (const auto& a : WebInputLayout::kKeyboard) {
        for (const auto& b : WebInputLayout::kKeyboard) {
            if (&a == &b || a.scancode != b.scancode) continue;
            const std::string pair = std::string(a.control) + "|" + b.control;
            const bool allowed = pair == "R|R analog" || pair == "R analog|R" || pair == "L|L analog" ||
                                 pair == "L analog|L";
            if (!allowed || std::strcmp(a.code, b.code) != 0) {
                unique = false;
                std::printf("  shared key: %s\n", pair.c_str());
            }
        }
    }
    Check(unique, "layout: no key is shared except L / R with their analog triggers");

    // The layout the operator asked for (GameCube semantics for Mario Kart Wii).
    const std::pair<const char*, int32_t> expected[] = {
        {"Stick right", SDL_SCANCODE_RIGHT}, {"Stick left", SDL_SCANCODE_LEFT}, {"Stick up", SDL_SCANCODE_UP},
        {"Stick down", SDL_SCANCODE_DOWN},   {"A", SDL_SCANCODE_X},             {"B", SDL_SCANCODE_Z},
        {"R", SDL_SCANCODE_LSHIFT},          {"R analog", SDL_SCANCODE_LSHIFT}, {"L", SDL_SCANCODE_SPACE},
        {"L analog", SDL_SCANCODE_SPACE},    {"Start", SDL_SCANCODE_RETURN},    {"X", SDL_SCANCODE_C},
        {"Y", SDL_SCANCODE_V},               {"Z", SDL_SCANCODE_Q},             {"C-stick up", SDL_SCANCODE_I},
        {"C-stick left", SDL_SCANCODE_J},    {"C-stick down", SDL_SCANCODE_K},  {"C-stick right", SDL_SCANCODE_L},
    };
    for (const auto& [control, scancode] : expected) {
        const auto* entry = Find(control);
        Check(entry != nullptr && entry->scancode == scancode, std::string("layout: ") + control + " key");
    }
}

void TestKeyboardStatus() {
    const Layout layout;
    PADStatus s = layout.Press({});
    Check(s.button == 0 && s.stickX == 0 && s.stickY == 0 && s.triggerLeft == 0 && s.triggerRight == 0,
          "keyboard: nothing held -> neutral");

    s = layout.Press({SDL_SCANCODE_X});
    Check(s.button == PAD_BUTTON_A, "keyboard: X -> A");
    s = layout.Press({SDL_SCANCODE_Z, SDL_SCANCODE_RETURN});
    Check(s.button == (PAD_BUTTON_B | PAD_BUTTON_START), "keyboard: Z + Enter -> B + Start");
    s = layout.Press({SDL_SCANCODE_LSHIFT});
    Check((s.button & PAD_TRIGGER_R) != 0 && s.triggerRight == 255 && s.triggerLeft == 0,
          "keyboard: Shift -> R pressed with a full analog pull");
    s = layout.Press({SDL_SCANCODE_SPACE});
    Check((s.button & PAD_TRIGGER_L) != 0 && s.triggerLeft == 255, "keyboard: Space -> L with a full analog pull");
    s = layout.Press({SDL_SCANCODE_C, SDL_SCANCODE_V, SDL_SCANCODE_Q});
    Check(s.button == (PAD_BUTTON_X | PAD_BUTTON_Y | PAD_TRIGGER_Z), "keyboard: C V Q -> X Y Z");
    s = layout.Press({SDL_SCANCODE_W, SDL_SCANCODE_D});
    Check(s.button == (PAD_BUTTON_UP | PAD_BUTTON_RIGHT), "keyboard: W D -> D-pad up + right");

    s = layout.Press({SDL_SCANCODE_LEFT});
    Check(s.stickX == -127 && s.stickY == 0, "keyboard: Left arrow -> stick X -127");
    s = layout.Press({SDL_SCANCODE_UP, SDL_SCANCODE_RIGHT});
    Check(s.stickX == 127 && s.stickY == 127, "keyboard: Up + Right -> stick (127, 127)");
    s = layout.Press({SDL_SCANCODE_LEFT, SDL_SCANCODE_RIGHT});
    Check(s.stickX == 0, "keyboard: Left + Right cancel");
    s = layout.Press({SDL_SCANCODE_I, SDL_SCANCODE_J});
    Check(s.substickX == -127 && s.substickY == 127 && s.stickX == 0, "keyboard: I + J -> C-stick up-left");
    s = layout.Press({SDL_SCANCODE_K, SDL_SCANCODE_L});
    Check(s.substickX == 127 && s.substickY == -127, "keyboard: K + L -> C-stick down-right");
    s = layout.Press({SDL_SCANCODE_A});
    Check(s.stickX == 0 && s.button == PAD_BUTTON_LEFT, "keyboard: A is the D-pad, not the stick");
}

void TestMerge() {
    PADStatus pad{};
    pad.button = PAD_BUTTON_A;
    pad.stickX = 40;
    pad.stickY = -100;
    pad.substickX = 10;
    pad.triggerLeft = 90;
    pad.triggerRight = 200;
    pad.err = PAD_ERR_NONE;
    pad.extButton = PAD_BUTTON_BACK;

    PADStatus keys{};
    keys.button = PAD_BUTTON_B | PAD_TRIGGER_R;
    keys.stickX = -127;
    keys.stickY = 0;
    keys.triggerRight = 255;
    keys.err = PAD_ERR_NO_CONTROLLER;  // ignored by the merge

    PADStatus merged = pad;
    aurora::pad::merge_status(merged, keys);
    Check(merged.button == (PAD_BUTTON_A | PAD_BUTTON_B | PAD_TRIGGER_R), "merge: buttons are ORed");
    Check(merged.extButton == PAD_BUTTON_BACK, "merge: extended buttons are kept");
    Check(merged.stickX == -127, "merge: larger stick deflection wins (keyboard -127 over pad 40)");
    Check(merged.stickY == -100, "merge: centred keyboard axis keeps the pad's deflection");
    Check(merged.substickX == 10 && merged.substickY == 0, "merge: C-stick keeps the pad value");
    Check(merged.triggerLeft == 90 && merged.triggerRight == 255, "merge: triggers take the larger value");
    Check(merged.err == PAD_ERR_NONE, "merge: err is not touched");

    PADStatus idle{};
    PADStatus onlyPad = pad;
    aurora::pad::merge_status(onlyPad, idle);
    Check(std::memcmp(&onlyPad, &pad, sizeof(PADStatus)) == 0, "merge: an idle keyboard leaves the pad untouched");

    PADStatus onlyKeys{};
    aurora::pad::merge_status(onlyKeys, keys);
    Check(onlyKeys.button == keys.button && onlyKeys.stickX == -127 && onlyKeys.triggerRight == 255,
          "merge: an idle pad passes the keyboard through");

    Check(aurora::pad::stronger_axis(-128, 127) == -128, "merge: -128 counts as the larger deflection");
    Check(aurora::pad::stronger_axis(50, -50) == 50, "merge: a tie keeps the first source");

    // Opposite directions: the stronger one wins outright (no cancelling between sources).
    PADStatus a{};
    a.stickX = 100;
    PADStatus b{};
    b.stickX = -60;
    aurora::pad::merge_status(a, b);
    Check(a.stickX == 100, "merge: opposite deflections -> the larger one, not the sum");
}

void AppendJson(std::string& out, const char* text) {
    out += '"';
    for (const char* c = text; *c != '\0'; ++c) {
        if (*c == '"' || *c == '\\') out += '\\';
        out += *c;
    }
    out += '"';
}

} // namespace

int main(int argc, char** argv) {
    if (argc > 1 && std::strcmp(argv[1], "--layout-json") == 0) {
        std::string json = "[";
        for (size_t i = 0; i < WebInputLayout::kKeyboard.size(); ++i) {
            const auto& e = WebInputLayout::kKeyboard[i];
            if (i != 0) json += ",";
            json += "\n  {\"control\":";
            AppendJson(json, e.control);
            json += ",\"code\":";
            AppendJson(json, e.code);
            json += ",\"key\":";
            AppendJson(json, e.key);
            json += ",\"sdlName\":";
            AppendJson(json, e.sdlName);
            json += ",\"action\":";
            AppendJson(json, e.action);
            json += "}";
        }
        json += "\n]\n";
        std::fputs(json.c_str(), stdout);
        return 0;
    }
    TestLayoutShape();
    TestKeyboardStatus();
    TestMerge();
    std::printf(g_failures ? "%d FAILED\n" : "ALL PASSED\n", g_failures);
    return g_failures ? 1 : 0;
}
