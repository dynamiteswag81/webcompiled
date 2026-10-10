// Dear ImGui's WebGPU backend (v1.91.9) treats __EMSCRIPTEN__ as the legacy `-sUSE_WEBGPU`
// bindings, which current Emscripten no longer ships. The emdawnwebgpu port exposes Dawn's
// webgpu.h instead, so build the backend's Dawn path: pull in every header it needs while
// __EMSCRIPTEN__ is still defined (their include guards keep them from being re-read), then
// hide the macro for the backend source alone.
#include <limits.h>
#include <webgpu/webgpu.h>

#include "imgui.h"
#include "backends/imgui_impl_wgpu.h"

#pragma push_macro("__EMSCRIPTEN__")
#undef __EMSCRIPTEN__
#define IMGUI_IMPL_WEBGPU_BACKEND_DAWN
#include "backends/imgui_impl_wgpu.cpp"
#undef IMGUI_IMPL_WEBGPU_BACKEND_DAWN
#pragma pop_macro("__EMSCRIPTEN__")
