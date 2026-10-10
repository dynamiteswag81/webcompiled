#pragma once

// Pure helpers behind PADRead's keyboard path and the keyboard + gamepad merge.
// Nothing here touches SDL, so the unit test (web/tests/input/pad_merge_test.cpp)
// runs them natively without a window or a controller.

#include <dolphin/pad.h>

#include <algorithm>
#include <cstddef>
#include <cstdlib>

namespace aurora::pad {

// One port's status from its keyboard/mouse bindings. `pressed(scancode)` reports
// whether a bound key (scancode >= 0) or mouse button (PAD_KEY_MOUSE_*) is held;
// it is never asked about PAD_KEY_INVALID. A bound stick direction is a full
// deflection (127), a bound trigger a full pull (255); opposite keys cancel.
template <typename IsPressed>
PADStatus keyboard_status(const PADKeyButtonBinding* buttons, size_t buttonCount, const PADKeyAxisBinding* axes,
                          size_t axisCount, IsPressed&& pressed) {
  PADStatus status{};
  for (size_t i = 0; i < buttonCount; ++i) {
    if (buttons[i].scancode != PAD_KEY_INVALID && pressed(buttons[i].scancode)) {
      status.button |= buttons[i].padButton;
    }
  }

  int lx = 0, ly = 0, rx = 0, ry = 0, tl = 0, tr = 0;
  for (size_t i = 0; i < axisCount; ++i) {
    if (axes[i].scancode == PAD_KEY_INVALID || !pressed(axes[i].scancode)) {
      continue;
    }
    switch (axes[i].padAxis) {
    case PAD_AXIS_LEFT_X_POS:
      lx += 127;
      break;
    case PAD_AXIS_LEFT_X_NEG:
      lx -= 127;
      break;
    case PAD_AXIS_LEFT_Y_POS:
      ly += 127;
      break;
    case PAD_AXIS_LEFT_Y_NEG:
      ly -= 127;
      break;
    case PAD_AXIS_RIGHT_X_POS:
      rx += 127;
      break;
    case PAD_AXIS_RIGHT_X_NEG:
      rx -= 127;
      break;
    case PAD_AXIS_RIGHT_Y_POS:
      ry += 127;
      break;
    case PAD_AXIS_RIGHT_Y_NEG:
      ry -= 127;
      break;
    case PAD_AXIS_TRIGGER_L:
      tl += 255;
      break;
    case PAD_AXIS_TRIGGER_R:
      tr += 255;
      break;
    default:
      break;
    }
  }
  status.stickX = static_cast<s8>(std::clamp(lx, -127, 127));
  status.stickY = static_cast<s8>(std::clamp(ly, -127, 127));
  status.substickX = static_cast<s8>(std::clamp(rx, -127, 127));
  status.substickY = static_cast<s8>(std::clamp(ry, -127, 127));
  status.triggerLeft = static_cast<u8>(std::min(tl, 255));
  status.triggerRight = static_cast<u8>(std::min(tr, 255));
  return status;
}

// The deflection farther from centre wins; on a tie the first source is kept.
constexpr s8 stronger_axis(s8 a, s8 b) {
  const int ma = a < 0 ? -static_cast<int>(a) : a;
  const int mb = b < 0 ? -static_cast<int>(b) : b;
  return mb > ma ? b : a;
}

// Two input sources driving one port (keyboard + gamepad): buttons are ORed,
// each stick axis takes the larger deflection, triggers and analog buttons the
// larger value. `err` is left alone: the caller decides whether the port exists.
inline void merge_status(PADStatus& into, const PADStatus& from) {
  into.button |= from.button;
#ifdef TARGET_PC
  into.extButton |= from.extButton;
#endif
  into.stickX = stronger_axis(into.stickX, from.stickX);
  into.stickY = stronger_axis(into.stickY, from.stickY);
  into.substickX = stronger_axis(into.substickX, from.substickX);
  into.substickY = stronger_axis(into.substickY, from.substickY);
  into.triggerLeft = std::max(into.triggerLeft, from.triggerLeft);
  into.triggerRight = std::max(into.triggerRight, from.triggerRight);
  into.analogA = std::max(into.analogA, from.analogA);
  into.analogB = std::max(into.analogB, from.analogB);
}

} // namespace aurora::pad
