#include "host_context.h"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#elif defined(__APPLE__) && defined(__aarch64__)
#include <sys/mman.h>
#include <unistd.h>

extern "C" void mkw_co_switch(void** targetSp, void** sourceSp);
extern "C" void* mkw_co_init(void* stackTop, void (*entry)(void*), void* argument);
#elif defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#include <emscripten/stack.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>

// JS side lives in web/js/library_mkw_host.js. mkw_host_context_switch is a
// JSPI-suspending import; mkw_host_context_entry is a JSPI (promising) export.
extern "C" void mkw_host_context_switch(void* source, void* destination);
extern "C" void _emscripten_stack_restore(uintptr_t stackPointer);
#elif defined(__linux__) || (defined(__APPLE__) && defined(__x86_64__))
#include <libco.h>

#include <cstdlib>
#include <unordered_map>
#else
#error "HostContext needs a supported cooperative-context backend"
#endif

namespace HostContext {

#if defined(_WIN32)

namespace {
thread_local bool g_convertedScheduler = false;
}

bool InitializeScheduler(Handle* scheduler)
{
    void* context = ConvertThreadToFiber(nullptr);
    g_convertedScheduler = context != nullptr;
    if (!context) {
        context = GetCurrentFiber();
    }
    *scheduler = context;
    return context != nullptr;
}

void ShutdownScheduler(Handle scheduler)
{
    if (scheduler && g_convertedScheduler) {
        ConvertFiberToThread();
    }
    g_convertedScheduler = false;
}

Handle Create(std::size_t stackSize, Entry entry, void* argument)
{
    return CreateFiber(stackSize, entry, argument);
}

void Destroy(Handle context)
{
    if (context) {
        DeleteFiber(context);
    }
}

bool IsCurrent(Handle context)
{
    return context != nullptr && GetCurrentFiber() == context;
}

void Switch(Handle target)
{
    SwitchToFiber(target);
}

#elif defined(__APPLE__) && defined(__aarch64__)

namespace {
struct Context {
    void* savedStackPointer = nullptr;
    void* stack = nullptr;
    std::size_t stackSize = 0;
};

// Guest scheduling is confined to the initialized main host thread. Keeping
// this as ordinary process state also avoids relying on Darwin TLS internals
// while executing on a manually managed stack.
Context* g_current = nullptr;
}

bool InitializeScheduler(Handle* scheduler)
{
    auto* context = new Context();
    g_current = context;
    *scheduler = context;
    return true;
}

void ShutdownScheduler(Handle scheduler)
{
    auto* context = static_cast<Context*>(scheduler);
    if (g_current == context) {
        g_current = nullptr;
    }
    delete context;
}

Handle Create(std::size_t stackSize, Entry entry, void* argument)
{
    auto* context = new Context();
    const std::size_t guardSize = static_cast<std::size_t>(getpagesize());
    const std::size_t totalSize = stackSize + guardSize;
    context->stack = mmap(nullptr, totalSize, PROT_READ | PROT_WRITE,
                          MAP_ANON | MAP_PRIVATE, -1, 0);
    if (context->stack == MAP_FAILED) {
        delete context;
        return nullptr;
    }
    // Fault on stack overflow instead of corrupting the preceding mapping.
    if (mprotect(context->stack, guardSize, PROT_NONE) != 0) {
        munmap(context->stack, totalSize);
        delete context;
        return nullptr;
    }
    context->stackSize = totalSize;

    auto* stackTop = static_cast<char*>(context->stack) + totalSize;
    context->savedStackPointer = mkw_co_init(stackTop, entry, argument);
    return context;
}

void Destroy(Handle context)
{
    auto* nativeContext = static_cast<Context*>(context);
    if (!nativeContext) {
        return;
    }
    if (nativeContext->stack) {
        munmap(nativeContext->stack, nativeContext->stackSize);
    }
    delete nativeContext;
}

bool IsCurrent(Handle context)
{
    return context != nullptr && context == g_current;
}

void Switch(Handle target)
{
    auto* destination = static_cast<Context*>(target);
    Context* source = g_current;
    if (!destination || destination == source) {
        return;
    }

    g_current = destination;
    mkw_co_switch(&destination->savedStackPointer, &source->savedStackPointer);
    g_current = source;
}

#elif defined(__EMSCRIPTEN__)

// WebAssembly has no way to switch native stacks, and Emscripten's own fibers
// are built on Asyncify (which would instrument every translated function).
// Instead every context is its own JSPI-suspendable call stack:
//   * the scheduler context is the stack running main();
//   * a created context starts as a call into the promising export
//     mkw_host_context_entry, issued from a microtask once its creator has
//     suspended;
//   * Switch() suspends the caller on a promise that the JS side resolves when
//     some later Switch() targets it again.
// The wasm value stacks are owned by the engine, but the C shadow stack
// (__stack_pointer) is a single global, so each context owns a malloc'd shadow
// stack and Switch() reinstates the caller's pointer after every resume.
namespace {
struct Context {
    Entry entry = nullptr;
    void* argument = nullptr;
    uint8_t* stack = nullptr;       // nullptr for the scheduler (Emscripten's main stack)
    std::size_t stackSize = 0;
    uintptr_t stackBase = 0;        // highest address (stack grows down)
    uintptr_t stackEnd = 0;         // lowest address
    uintptr_t savedStackPointer = 0;
};

Context* g_current = nullptr;

void InstallStack(const Context* context, uintptr_t stackPointer)
{
    emscripten_stack_set_limits(reinterpret_cast<void*>(context->stackBase),
                                reinterpret_cast<void*>(context->stackEnd));
    _emscripten_stack_restore(stackPointer);
}
} // namespace

extern "C" EMSCRIPTEN_KEEPALIVE void mkw_host_context_entry(void* handle)
{
    auto* context = static_cast<Context*>(handle);
    g_current = context;
    InstallStack(context, context->stackBase);
    context->entry(context->argument);
    // A guest fiber always switches away for good instead of returning (the
    // same contract as Win32 fibers); returning would silently strand the
    // context that should run next.
    std::fprintf(stderr, "HostContext: context %p returned from its entry\n", handle);
    std::abort();
}

bool InitializeScheduler(Handle* scheduler)
{
    auto* context = new Context();
    context->stackBase = emscripten_stack_get_base();
    context->stackEnd = emscripten_stack_get_end();
    g_current = context;
    *scheduler = context;
    return true;
}

void ShutdownScheduler(Handle scheduler)
{
    auto* context = static_cast<Context*>(scheduler);
    if (g_current == context) {
        g_current = nullptr;
    }
    delete context;
}

Handle Create(std::size_t stackSize, Entry entry, void* argument)
{
    auto* context = new Context();
    context->entry = entry;
    context->argument = argument;
    context->stackSize = (stackSize + 15u) & ~std::size_t{15};
    context->stack = static_cast<uint8_t*>(std::aligned_alloc(16, context->stackSize));
    if (!context->stack) {
        delete context;
        return nullptr;
    }
    context->stackEnd = reinterpret_cast<uintptr_t>(context->stack);
    context->stackBase = context->stackEnd + context->stackSize;
    return context;
}

void Destroy(Handle handle)
{
    auto* context = static_cast<Context*>(handle);
    if (!context) {
        return;
    }
    // A destroyed context is never resumed again; its suspended engine stack
    // is released with the JS resolver that referenced it.
    EM_ASM({ Module.mkwHostContextForget($0); }, context);
    std::free(context->stack);
    delete context;
}

bool IsCurrent(Handle context)
{
    return context != nullptr && context == g_current;
}

void Switch(Handle target)
{
    auto* destination = static_cast<Context*>(target);
    Context* source = g_current;
    if (!destination || destination == source) {
        return;
    }

    source->savedStackPointer = emscripten_stack_get_current();
    g_current = destination;
    mkw_host_context_switch(source, destination);
    // Resumed: whichever context ran last left its own shadow-stack pointer in
    // the global, so reinstate ours before this frame calls anything.
    g_current = source;
    InstallStack(source, source->savedStackPointer);
}

#elif defined(__linux__) || (defined(__APPLE__) && defined(__x86_64__))

namespace {
struct Context {
    cothread_t native = nullptr;
    Entry entry = nullptr;
    void* argument = nullptr;
    bool ownsNative = false;
};

thread_local Context* g_current = nullptr;
thread_local std::unordered_map<cothread_t, Context*> g_contexts;

void ContextEntry()
{
    const auto found = g_contexts.find(co_active());
    if (found == g_contexts.end() || !found->second || !found->second->entry) {
        std::abort();
    }

    Context* context = found->second;
    g_current = context;
    context->entry(context->argument);

    // A guest fiber must return through FiberProc's scheduler handoff. There
    // is no valid native caller to return to from libco's entry trampoline.
    std::abort();
}
} // namespace

bool InitializeScheduler(Handle* scheduler)
{
    auto* context = new Context();
    context->native = co_active();
    if (!context->native) {
        delete context;
        return false;
    }

    g_current = context;
    g_contexts.emplace(context->native, context);
    *scheduler = context;
    return true;
}

void ShutdownScheduler(Handle scheduler)
{
    auto* context = static_cast<Context*>(scheduler);
    if (!context) {
        return;
    }

    g_contexts.erase(context->native);
    if (g_current == context) {
        g_current = nullptr;
    }
    delete context;
}

Handle Create(std::size_t stackSize, Entry entry, void* argument)
{
    auto* context = new Context();
    context->entry = entry;
    context->argument = argument;
    context->native = co_create(static_cast<unsigned int>(stackSize), ContextEntry);
    context->ownsNative = context->native != nullptr;
    if (!context->native) {
        delete context;
        return nullptr;
    }

    g_contexts.emplace(context->native, context);
    return context;
}

void Destroy(Handle context)
{
    auto* nativeContext = static_cast<Context*>(context);
    if (!nativeContext) {
        return;
    }

    g_contexts.erase(nativeContext->native);
    if (nativeContext->ownsNative) {
        co_delete(nativeContext->native);
    }
    delete nativeContext;
}

bool IsCurrent(Handle context)
{
    return context != nullptr && context == g_current;
}

void Switch(Handle target)
{
    auto* destination = static_cast<Context*>(target);
    Context* source = g_current;
    if (!destination || destination == source) {
        return;
    }

    g_current = destination;
    co_switch(destination->native);
    g_current = source;
}

#endif

} // namespace HostContext
