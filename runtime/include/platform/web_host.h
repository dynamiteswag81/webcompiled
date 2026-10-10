#pragma once

// Waiting in the browser build. The game never returns from main(), so a plain
// sleep (libc nanosleep busy-waits on the main thread) would freeze the page:
// no rendering, no input, no fetch completions. Instead the waiting wasm stack
// suspends through JSPI (web/js/library_mkw_host.js) and the browser runs.
// Callers must be on a JSPI-suspendable stack: main() or a guest host context,
// never a JS callback.

#include <atomic>
#include <chrono>
#include <cstdint>

#if defined(__EMSCRIPTEN__)
extern "C" void mkw_host_yield(int ms);
extern "C" int mkw_host_page_hidden(void);
extern "C" void mkw_host_wait_visible(void);
extern "C" void mkw_host_note_frame(void);
#else
#include <thread>
#endif

namespace WebHost {

// Total host time the guest spent parked while the page was hidden. Guest-visible clocks subtract
// it so a background tab looks like a paused console, not a time jump. Always 0 natively.
inline std::atomic<int64_t>& ParkedNanosCounter() {
    static std::atomic<int64_t> parked{0};
    return parked;
}
inline int64_t ParkedNanos() { return ParkedNanosCounter().load(std::memory_order_relaxed); }

#if defined(__EMSCRIPTEN__)
// A single macrotask hop: the browser renders, delivers input and settles
// promises, then this stack resumes (no setTimeout clamp).
inline void Yield() { mkw_host_yield(0); }

// Waits until `deadline`. Whole milliseconds sleep on a browser timer (unclamped, see
// mkw_host_yield; it fires at or a little after the requested time); only the sub-millisecond
// remainder is covered by macrotask hops. Hopping through whole waits instead spun the idle
// scheduler at ~150k hops/s, a full core whenever the game had nothing to do.
template <typename Clock, typename Duration>
inline void SleepUntil(std::chrono::time_point<Clock, Duration> deadline) {
    using namespace std::chrono;
    for (auto now = Clock::now(); now < deadline; now = Clock::now()) {
        const auto wholeMs = duration_cast<milliseconds>(deadline - now).count();
        mkw_host_yield(wholeMs >= 1 ? static_cast<int>(wholeMs) : 0);
    }
}
// True while document.visibilityState is "hidden" (background tab, minimized window).
inline bool PageHidden() { return mkw_host_page_hidden() != 0; }

// If the page is hidden, suspends this stack (JSPI) until it is visible again and returns how long
// that took; returns zero at once otherwise. Nothing else in the module runs meanwhile: every guest
// thread is a context on this one stack, so the whole console is paused. The caller must restart
// whatever it paces against the host clock (VI retraces, audio output).
inline std::chrono::steady_clock::duration WaitWhilePageHidden() {
    if (!PageHidden()) {
        return {};
    }
    const auto start = std::chrono::steady_clock::now();
    mkw_host_wait_visible();
    const auto parked = std::chrono::steady_clock::now() - start;
    ParkedNanosCounter().fetch_add(
        std::chrono::duration_cast<std::chrono::nanoseconds>(parked).count(), std::memory_order_relaxed);
    return parked;
}

// Counts a presented frame for the page (Module.mkwFramesPresented: diagnostics and tests).
inline void NoteFramePresented() { mkw_host_note_frame(); }
#else
inline void Yield() {}
inline bool PageHidden() { return false; }
inline std::chrono::steady_clock::duration WaitWhilePageHidden() { return {}; }
inline void NoteFramePresented() {}

template <typename Clock, typename Duration>
inline void SleepUntil(std::chrono::time_point<Clock, Duration> deadline) {
    std::this_thread::sleep_until(deadline);
}
#endif

template <typename Rep, typename Period>
inline void SleepFor(std::chrono::duration<Rep, Period> duration) {
    SleepUntil(std::chrono::steady_clock::now() + duration);
}

} // namespace WebHost
