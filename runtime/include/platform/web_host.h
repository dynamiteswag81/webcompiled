#pragma once

// Waiting in the browser build. The game never returns from main(), so a plain
// sleep (libc nanosleep busy-waits on the main thread) would freeze the page:
// no rendering, no input, no fetch completions. Instead the waiting wasm stack
// suspends through JSPI (web/js/library_mkw_host.js) and the browser runs.
// Callers must be on a JSPI-suspendable stack: main() or a guest host context,
// never a JS callback.

#include <chrono>

#if defined(__EMSCRIPTEN__)
extern "C" void mkw_host_yield(int ms);
#else
#include <thread>
#endif

namespace WebHost {

#if defined(__EMSCRIPTEN__)
// A single macrotask hop: the browser renders, delivers input and settles
// promises, then this stack resumes (no setTimeout clamp).
inline void Yield() { mkw_host_yield(0); }

// Waits until `deadline`. Long waits sleep on a timer that fires ~2 ms early
// (browser timers are coarse); the remainder is covered by macrotask hops, so
// the deadline is met without starving the page.
template <typename Clock, typename Duration>
inline void SleepUntil(std::chrono::time_point<Clock, Duration> deadline) {
    using namespace std::chrono;
    constexpr auto kTimerSlack = milliseconds(2);
    for (auto now = Clock::now(); now < deadline; now = Clock::now()) {
        const auto remaining = deadline - now;
        if (remaining > kTimerSlack + milliseconds(1)) {
            mkw_host_yield(static_cast<int>(duration_cast<milliseconds>(remaining - kTimerSlack).count()));
        } else {
            mkw_host_yield(0);
        }
    }
}
#else
inline void Yield() {}

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
