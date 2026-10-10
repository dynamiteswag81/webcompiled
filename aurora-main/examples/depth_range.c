// GX viewport depth ranges outside [0, 1] (test example; no game data).
//
// Games set viewports such as GXSetViewport(..., nearZ = -0.06, farZ = 0.05) to bias geometry
// toward the near plane (Mario Kart Wii does this; under reversed Z it becomes the host range
// 0.95..1.06). WebGPU rejects SetViewport depths outside [0, 1]. Aurora gives such draws a [0, 1]
// pass viewport and writes the GX depth from the fragment shader, clamped like the hardware.
//
// Each frame draws one flat quad per case into its own column (each with its own viewport) and
// reads the stored depth back with GXPeekZ. After a few frames it prints one line per case and
// "DEPTH-RANGE-TEST PASS" or "DEPTH-RANGE-TEST FAIL" (web/tests/aurora_depth_range_test.mjs
// checks that line). It then keeps rendering so the page stays inspectable.
#include <aurora/aurora.h>
#include <aurora/event.h>
#include <aurora/main.h>
#include <dolphin/gx.h>

#include <stdio.h>
#include <stdlib.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

EM_ASYNC_JS(void, wait_for_animation_frame, (), {
  await new Promise((resolve) => requestAnimationFrame(resolve));
});
#endif

typedef struct {
  float nearZ; // GXSetViewport nearZ / farZ
  float farZ;
  float z;     // vertex z; GX clip space keeps -1 (near) .. 0 (far) for this orthographic projection
} DepthCase;

static const DepthCase kCases[] = {
    {-0.06f, 0.05f, -0.95f}, // near end below 0: GX depth -0.0545, clamped to 0
    {-0.06f, 0.05f, -0.25f}, // inside the representable part: 0.0225
    {-0.06f, 0.05f, -0.01f}, // 0.0489
    {0.0f, 1.0f, -0.5f},     // ordinary viewport (no fixup): 0.5
    {0.95f, 1.06f, -0.9f},   // far end above 1: 0.961
};
#define CASE_COUNT ((int)(sizeof(kCases) / sizeof(kCases[0])))
#define EFB_WIDTH 640
#define EFB_HEIGHT 480
#define COLUMN_WIDTH (EFB_WIDTH / CASE_COUNT)
// 24-bit depth units; float32 depth near 1.0 is good to about one unit.
#define TOLERANCE 256

static unsigned char s_fifo[256 * 1024] __attribute__((aligned(32)));

static void log_callback(AuroraLogLevel level, const char* module, const char* message, unsigned int len) {
  (void)len;
  const char* levelStr = "INFO";
  FILE* out = stdout;
  switch (level) {
  case LOG_DEBUG:
    levelStr = "DEBUG";
    break;
  case LOG_INFO:
    levelStr = "INFO";
    break;
  case LOG_WARNING:
    levelStr = "WARNING";
    break;
  case LOG_ERROR:
    levelStr = "ERROR";
    out = stderr;
    break;
  case LOG_FATAL:
    levelStr = "FATAL";
    out = stderr;
    break;
  }
  fprintf(out, "[%s: %s;%s]\n", levelStr, module, message);
  if (level == LOG_FATAL) {
    fflush(out);
    abort();
  }
}

// What GX stores: depth = farZ + z_ndc * (farZ - nearZ), clamped to [0, 1], in 24-bit units.
static unsigned expected_depth(const DepthCase* c) {
  double depth = c->farZ + c->z * (c->farZ - c->nearZ);
  if (depth < 0.0) {
    depth = 0.0;
  }
  if (depth > 1.0) {
    depth = 1.0;
  }
  return (unsigned)(depth * 16777215.0 + 0.5);
}

static void setup_state(void) {
  f32 proj[4][4] = {{1.f, 0.f, 0.f, 0.f}, {0.f, 1.f, 0.f, 0.f}, {0.f, 0.f, 1.f, 0.f}, {0.f, 0.f, 0.f, 1.f}};
  f32 modelView[3][4] = {{1.f, 0.f, 0.f, 0.f}, {0.f, 1.f, 0.f, 0.f}, {0.f, 0.f, 1.f, 0.f}};
  GXSetProjection(proj, GX_ORTHOGRAPHIC);
  GXLoadPosMtxImm(modelView, GX_PNMTX0);
  GXSetCurrentMtx(GX_PNMTX0);
  GXClearVtxDesc();
  GXSetVtxDesc(GX_VA_POS, GX_DIRECT);
  GXSetVtxDesc(GX_VA_CLR0, GX_DIRECT);
  GXSetVtxAttrFmt(GX_VTXFMT0, GX_VA_POS, GX_POS_XYZ, GX_F32, 0);
  GXSetVtxAttrFmt(GX_VTXFMT0, GX_VA_CLR0, GX_CLR_RGBA, GX_RGBA8, 0);
  GXSetNumChans(1);
  GXSetChanCtrl(GX_COLOR0A0, GX_FALSE, GX_SRC_REG, GX_SRC_VTX, GX_LIGHT_NULL, GX_DF_NONE, GX_AF_NONE);
  GXSetNumTexGens(0);
  GXSetNumTevStages(1);
  GXSetTevOrder(GX_TEVSTAGE0, GX_TEXCOORD_NULL, GX_TEXMAP_NULL, GX_COLOR0A0);
  GXSetTevOp(GX_TEVSTAGE0, GX_PASSCLR);
  GXSetZMode(GX_TRUE, GX_ALWAYS, GX_TRUE);
  GXSetCullMode(GX_CULL_NONE);
  GXSetBlendMode(GX_BM_NONE, GX_BL_ONE, GX_BL_ZERO, GX_LO_CLEAR);
  GXSetColorUpdate(GX_TRUE);
  GXSetScissor(0, 0, EFB_WIDTH, EFB_HEIGHT);
}

static void draw_case(int i) {
  const DepthCase* c = &kCases[i];
  GXSetViewport((f32)(i * COLUMN_WIDTH), 0.f, (f32)COLUMN_WIDTH, (f32)EFB_HEIGHT, c->nearZ, c->farZ);
  const u8 shade = (u8)(80 + 40 * i);
  GXBegin(GX_QUADS, GX_VTXFMT0, 4);
  GXPosition3f32(-1.f, 1.f, c->z);
  GXColor4u8(shade, 255 - shade, 128, 255);
  GXPosition3f32(1.f, 1.f, c->z);
  GXColor4u8(shade, 255 - shade, 128, 255);
  GXPosition3f32(1.f, -1.f, c->z);
  GXColor4u8(shade, 255 - shade, 128, 255);
  GXPosition3f32(-1.f, -1.f, c->z);
  GXColor4u8(shade, 255 - shade, 128, 255);
  GXEnd();
}

int main(int argc, char* argv[]) {
  const AuroraConfig config = {
      .appName = "DepthRange",
      .logCallback = &log_callback,
  };
  aurora_initialize(argc, argv, &config);
  GXInit(s_fifo, sizeof(s_fifo));
  printf("DEPTH-RANGE-TEST start\n");

  int frame = 0;
  int reported = 0;
  for (;;) {
    const AuroraEvent* event = aurora_update();
    int exiting = 0;
    while (event != NULL && event->type != AURORA_NONE) {
      if (event->type == AURORA_EXIT) {
        exiting = 1;
      }
      ++event;
    }
    if (exiting) {
      break;
    }
    if (!aurora_begin_frame()) {
#ifdef __EMSCRIPTEN__
      wait_for_animation_frame();
#endif
      continue;
    }
    GXSetCopyClear((GXColor){0, 0, 0, 255}, GX_MAX_Z24);
    setup_state();
    for (int i = 0; i < CASE_COUNT; ++i) {
      draw_case(i);
    }
    // GXPeekZ answers from the newest completed depth snapshot (a frame or two behind) and asks
    // for the next one, so peek every frame and report once the values have settled.
    u32 peeked[CASE_COUNT];
    for (int i = 0; i < CASE_COUNT; ++i) {
      peeked[i] = 0;
      GXPeekZ((u16)(i * COLUMN_WIDTH + COLUMN_WIDTH / 2), EFB_HEIGHT / 2, &peeked[i]);
    }
    aurora_end_frame();
    ++frame;
    if (!reported && frame >= 30) {
      reported = 1;
      int failures = 0;
      for (int i = 0; i < CASE_COUNT; ++i) {
        const unsigned expected = expected_depth(&kCases[i]);
        const long diff = (long)peeked[i] - (long)expected;
        const int ok = labs(diff) <= TOLERANCE;
        failures += !ok;
        printf("DEPTH-RANGE-TEST case %d: viewport z %.2f..%.2f, vertex z %.2f: depth %u, expected %u (%s)\n", i,
               kCases[i].nearZ, kCases[i].farZ, kCases[i].z, (unsigned)peeked[i], expected, ok ? "ok" : "WRONG");
      }
      printf("DEPTH-RANGE-TEST %s\n", failures == 0 ? "PASS" : "FAIL");
      fflush(stdout);
    }
#ifdef __EMSCRIPTEN__
    wait_for_animation_frame();
#endif
  }

  aurora_shutdown();
  return 0;
}
