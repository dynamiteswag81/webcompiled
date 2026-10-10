#pragma once

// [web] Browser input glue (runtime/src/platform/web/web_input.cpp, web/js/library_mkw_input.js):
// the default keyboard layout on port 1 (web_input_layout.h), keyboard + gamepad merging, and a
// cheap per-port snapshot of exactly what the game's PADRead returned, which the page's Controls
// panel / input debug view reads (Module.mkwInput). Nothing here runs guest code; the JS side
// only reads memory and receives a JSON description when ports or bindings change.

#include <cstdint>

#include <dolphin/pad.h>

namespace WebInput {

// Before the game's first PADInit/PADRead: installs the port-1 keyboard defaults, turns on
// keyboard + gamepad merging and hands the snapshot to the page.
void Initialize() noexcept;

// After every guest PADRead, with the statuses as the game receives them.
void PublishPadStatus(const PADStatus* statuses, uint32_t count, uint32_t rumbleMask) noexcept;

// Merges the page's on-screen touch controls (web/site/touch.js) into port 1, after the keyboard,
// gamepads and InputBindings: buttons are ORed in, each stick / trigger takes whichever source is
// pushed further. Does nothing while the touch controls are hidden; the caller skips it while the
// settings bar blocks game input.
void ApplyTouch(PADStatus* statuses, uint32_t count) noexcept;

// Records the last motor command per port (shown in the debug view).
void NoteMotor(uint32_t port, uint32_t command) noexcept;

} // namespace WebInput
