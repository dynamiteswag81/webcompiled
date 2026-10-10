// Standalone check of the JSPI HostContext backend (runtime/src/host_context.cpp):
// ping-pong between contexts, per-context shadow stacks surviving interleaved
// switches, deep recursion, C++ exceptions inside a context, and host yields.
// Build: see web/tests/run_host_context_test.sh
#include "host_context.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>

extern "C" void mkw_host_yield(double ms);

namespace {
HostContext::Handle g_scheduler = nullptr;
HostContext::Handle g_workers[3] = {};
int g_log[64];
int g_logCount = 0;

int Recurse(int depth, volatile char* sink)
{
    char frame[256];  // forces shadow-stack use
    frame[depth & 255] = static_cast<char>(depth);
    sink[0] = frame[depth & 255];
    return depth == 0 ? 0 : 1 + Recurse(depth - 1, sink);
}

void Worker(void* argument)
{
    const int id = static_cast<int>(reinterpret_cast<intptr_t>(argument));
    char local[64];
    std::snprintf(local, sizeof(local), "worker-%d-canary", id);
    for (int round = 0; round < 4; ++round) {
        volatile char sink[1];
        if (Recurse(2000, sink) != 2000) std::abort();
        try {
            throw std::runtime_error("boom " + std::to_string(id));
        } catch (const std::exception& e) {
            if (std::string(e.what()) != "boom " + std::to_string(id)) std::abort();
        }
        if (round == 2) mkw_host_yield(0);
        g_log[g_logCount++] = id * 10 + round;
        // Canary must survive every interleaved switch (own shadow stack).
        char expected[64];
        std::snprintf(expected, sizeof(expected), "worker-%d-canary", id);
        if (std::string(local) != expected) {
            std::printf("FAIL: canary clobbered in worker %d\n", id);
            std::abort();
        }
        HostContext::Switch(g_scheduler);
    }
    HostContext::Switch(g_scheduler);
    std::abort();  // never resumed again
}
} // namespace

int main()
{
    if (!HostContext::InitializeScheduler(&g_scheduler)) return 1;
    for (int i = 0; i < 3; ++i) {
        g_workers[i] = HostContext::Create(256 * 1024, Worker, reinterpret_cast<void*>(intptr_t{i + 1}));
    }
    char mainCanary[32] = "main-canary";
    for (int round = 0; round < 4; ++round) {
        for (int i = 0; i < 3; ++i) {
            HostContext::Switch(g_workers[i]);
            if (std::string(mainCanary) != "main-canary") {
                std::printf("FAIL: main canary clobbered\n");
                return 1;
            }
        }
        mkw_host_yield(round == 1 ? 5 : 0);
    }
    for (auto* w : g_workers) HostContext::Destroy(w);
    std::printf("order:");
    for (int i = 0; i < g_logCount; ++i) std::printf(" %d", g_log[i]);
    std::printf("\n");
    const bool ok = g_logCount == 12 && g_log[0] == 10 && g_log[1] == 20 && g_log[2] == 30 &&
                    g_log[11] == 33;
    std::printf(ok ? "PASS host context test\n" : "FAIL host context test\n");
    return ok ? 0 : 1;
}
