// Browser input test harness (no game data): the real aurora (SDL3 Emscripten backend, PAD
// library, ImGui on WebGPU) plus the real runtime glue (runtime/src/platform/web/web_input.cpp,
// web/js/library_mkw_input.js), linked as WiiCompiled.js/.wasm so the real page (web/site) hosts
// it. Each frame it does what the game's PADRead path does on the web: aurora_update (SDL pumps
// navigator.getGamepads and keyboard events), PADRead, WebInput::ApplyTouch, WebInput::PublishPadStatus. The headless
// test (input_test.mjs) injects fake gamepads and keys and reads Module.mkwInput.
//
// Test hooks (Module properties the test sets; polled once per frame on the main loop):
//   mkwHarnessMotor  {port, cmd}           -> PADControlMotor(port, cmd) (+ WebInput::NoteMotor)
//   mkwHarnessRebind {padButton, scancode} -> port-1 key rebinding exactly like the F10 bar does
//                                             (PADSetKeyButtonBinding + PADSerializeMappings)
// Reported back in Module.mkwHarness: {frames, clicks (ImGui button), f10 (F10 key-downs seen
// as SDL events), userPath, persistent}.

#include <aurora/aurora.h>
#include <aurora/event.h>
#include <dolphin/pad.h>
#include <imgui.h>

#include <SDL3/SDL_events.h>

#include <emscripten.h>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>

#include "web_input.h"

extern "C" {
// web/js/library_mkw_dvd.js: pulls in the IDBFS-backed $HOME store the product uses.
int mkw_storage_is_persistent(void);
const char* mkw_dvd_mod_mount_name(void);
}

EM_ASYNC_JS(void, harness_wait_frame, (), {
  await new Promise((resolve) => requestAnimationFrame(resolve));
});

EM_JS(int, harness_take_motor, (), {
  const r = Module['mkwHarnessMotor'];
  if (r == null) return -1;
  Module['mkwHarnessMotor'] = null;
  return (r['port'] & 0xF) * 16 + (r['cmd'] & 0xF);
});

EM_JS(int, harness_take_rebind, (int* scancode), {
  const r = Module['mkwHarnessRebind'];
  if (r == null) return -1;
  Module['mkwHarnessRebind'] = null;
  HEAP32[scancode >> 2] = r['scancode'];
  return r['padButton'];
});

EM_JS(void, harness_report, (int frames, int clicks, int f10, const char* userPath, int persistent), {
  Module['mkwHarness'] = {
    'frames': frames, 'clicks': clicks, 'f10': f10,
    'userPath': UTF8ToString(userPath), 'persistent': persistent != 0,
  };
});

static void log_callback(AuroraLogLevel level, const char* module, const char* message, unsigned int) {
  std::fprintf(level >= LOG_ERROR ? stderr : stdout, "[aurora %d %s] %s\n", static_cast<int>(level), module,
               message);
  if (level == LOG_FATAL) {
    std::abort();
  }
}

int main() {
  // Same location the runtime uses on the web: $HOME/.local/share/WiiCompiled (RuntimeConfigFile::
  // ApplicationDataDirectory), inside the IndexedDB-backed $HOME mount.
  const char* home = std::getenv("HOME");
  const std::string userPath = std::string(home != nullptr ? home : "/home/web_user") + "/.local/share/WiiCompiled";
  std::error_code ec;
  std::filesystem::create_directories(userPath + "/Cache", ec);
  const std::string cachePath = userPath + "/Cache";
  (void)mkw_dvd_mod_mount_name();

  WebInput::Initialize();

  AuroraConfig config{};
  config.appName = "WiiCompiled input test";
  config.userPath = userPath.c_str();
  config.cachePath = cachePath.c_str();
  config.logCallback = &log_callback;
  config.windowWidth = 640;
  config.windowHeight = 480;
  const AuroraInfo info = aurora_initialize(0, nullptr, &config);
  if (info.initializationStatus != AURORA_INITIALIZATION_SUCCESS) {
    std::fprintf(stderr, "aurora_initialize failed: %s\n",
                 info.initializationError != nullptr ? info.initializationError : "?");
    return 1;
  }
  PADInit();
  std::printf("input harness running\n");

  int frames = 0;
  int clicks = 0;
  int f10 = 0;
  for (;;) {
    for (const AuroraEvent* event = aurora_update(); event != nullptr && event->type != AURORA_NONE; ++event) {
      if (event->type == AURORA_SDL_EVENT && event->sdl.type == SDL_EVENT_KEY_DOWN &&
          event->sdl.key.scancode == SDL_SCANCODE_F10 && !event->sdl.key.repeat) {
        ++f10;
      }
    }

    PADStatus statuses[PAD_CHANMAX]{};
    const u32 rumbleMask = PADRead(statuses);
    WebInput::ApplyTouch(statuses, PAD_CHANMAX);
    WebInput::PublishPadStatus(statuses, PAD_CHANMAX, rumbleMask);

    if (const int motor = harness_take_motor(); motor >= 0) {
      WebInput::NoteMotor(motor >> 4, motor & 0xF);
      PADControlMotor(motor >> 4, motor & 0xF);
    }
    int scancode = PAD_KEY_INVALID;
    if (const int padButton = harness_take_rebind(&scancode); padButton > 0) {
      PADSetKeyButtonBinding(0, PADKeyButtonBinding{scancode, static_cast<PADButton>(padButton)});
      PADSerializeMappings();
    }

    if (aurora_begin_frame()) {
      ImGui::SetNextWindowPos(ImVec2(60.0f, 380.0f));  // clear of the page's debug view (top left)
      ImGui::SetNextWindowSize(ImVec2(260.0f, 140.0f));
      ImGui::Begin("Input harness", nullptr, ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoResize |
                                                 ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoNav);
      if (ImGui::Button("Click me", ImVec2(200.0f, 60.0f))) {
        ++clicks;
      }
      ImGui::Text("clicks %d  F10 %d", clicks, f10);
      ImGui::End();
      aurora_end_frame();
    }
    ++frames;
    harness_report(frames, clicks, f10, userPath.c_str(), mkw_storage_is_persistent());
    harness_wait_frame();
  }
}
