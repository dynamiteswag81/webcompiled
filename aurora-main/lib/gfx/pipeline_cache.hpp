#pragma once

#include "common.hpp"

#include <functional>

namespace aurora::gfx::clear {
struct PipelineConfig;
} // namespace aurora::gfx::clear

namespace aurora::gx {
struct PipelineConfig;
} // namespace aurora::gx

namespace aurora::gfx {

using NewPipelineCallback = std::function<wgpu::RenderPipeline()>;

void initialize_pipeline_cache();
void shutdown_pipeline_cache();
void begin_pipeline_frame();
void end_pipeline_frame();
void set_skip_unready_pipelines(bool enabled) noexcept;
bool skip_unready_pipelines() noexcept;
uint32_t queued_pipeline_count() noexcept;

template <typename Config>
PipelineRef find_pipeline(ShaderType type, const Config& config, NewPipelineCallback&& cb);

bool wait_pipeline(PipelineRef ref, wgpu::RenderPipeline& pipeline);
// Pipeline creators call this instead of Device::CreateRenderPipeline. In the browser build, while
// the cache is building a queued pipeline, it starts createRenderPipelineAsync and returns null; the
// cache completes the entry when the browser has compiled it. Everywhere else it creates directly.
wgpu::RenderPipeline create_render_pipeline(const wgpu::RenderPipelineDescriptor& descriptor);
bool try_pipeline(PipelineRef ref, wgpu::RenderPipeline& pipeline);
// Waits indefinitely for a draw about to be committed to a persistent texture with no re-issue
// path. Separate from wait_pipeline so skip-unready mode never becomes blocking for other passes.
bool wait_pipeline_for_persistent_pass(PipelineRef ref, wgpu::RenderPipeline& pipeline);

} // namespace aurora::gfx
