#pragma once

#ifndef MKW_RUNTIME_LOG_H
#define MKW_RUNTIME_LOG_H

#include <cstdio>
#include <iostream>
#include <mutex>
#include <string>
#include <unordered_set>

#include "memory.h"

// Canonical module tags. Use one of these; never write a bare "[...]" prefix
// into a message. (A message whose text spans several output lines repeats the
// tag inline on the continuation lines - the macros only prefix the first.)
#define RT_TAG_RUNTIME "runtime"
#define RT_TAG_CONFIG "runtime-config"
#define RT_TAG_MEMORY "memory"
#define RT_TAG_MOD "mod"
#define RT_TAG_HLE "hle"
#define RT_TAG_OS "os"
#define RT_TAG_GX "gx"
#define RT_TAG_AUDIO "audio"
#define RT_TAG_NET "net"
#define RT_TAG_DVD "dvd"
#define RT_TAG_NAND "nand"
#define RT_TAG_RIIVOLUTION "riivolution"
#define RT_TAG_VI "vi"

// Stream form:  RT_LOG(RT_TAG_OS) << "OSCreateThread failed" << std::endl;
#define RT_LOG(tag) (std::cerr << "[" tag "] ")

// printf form:  RT_LOGF(RT_TAG_GX, "invalid GXTexObj @0x%08X\n", addr);
// `tag` and the format string must both be literals; they are concatenated.
#define RT_LOGF(tag, ...) std::fprintf(stderr, "[" tag "] " __VA_ARGS__)

// Informational form. Use these for progress notes, "stubbed" HLE call
// reports and expected misses (a probe for an optional file) - anything that is
// not a problem. Natively they are identical to RT_LOG / RT_LOGF (stderr), so
// native log files do not change. On the web, Emscripten forwards stderr to
// Module.printErr, which the page shows as console.error and the error report
// labels ERROR; informational lines go to stdout (Module.print -> console.log)
// so the real errors stay findable.
//   RT_LOG_INFO(RT_TAG_OS) << "SIInit called (stubbed)" << std::endl;
//   RT_LOGF_INFO(RT_TAG_HLE, "OS__CheckInstall -> success (stubbed)\n");
#if defined(__EMSCRIPTEN__)
#define RT_INFO_STREAM (std::cout)
#define RT_INFO_FILE stdout
#else
#define RT_INFO_STREAM (std::cerr)
#define RT_INFO_FILE stderr
#endif
#define RT_LOG_INFO(tag) (RT_INFO_STREAM << "[" tag "] ")
#define RT_LOGF_INFO(tag, ...) std::fprintf(RT_INFO_FILE, "[" tag "] " __VA_ARGS__)

// True the first time `key` is passed (thread-safe), false afterwards. For
// once-per-distinct-message logging, e.g. one line per missing optional file
// instead of one per probe. The set is bounded: past the cap every new key
// counts as seen, so a pathological caller cannot grow it without limit.
inline bool RtLogFirstTime(const std::string& key)
{
    static std::mutex mutex;
    static std::unordered_set<std::string> seen;
    constexpr size_t kMaxKeys = 4096;
    std::lock_guard<std::mutex> lock(mutex);
    if (seen.size() >= kMaxKeys) {
        return false;
    }
    return seen.insert(key).second;
}

// Shared epilogue for the `catch (const Memory::AccessViolation& e)` handlers
// spread across the HLE. `who` is the guest function or operation that faulted;
// the tag is its module.
inline void LogMemoryError(const char* tag, const char* who,
                           const ::Memory::AccessViolation& e)
{
    std::cerr << "[" << tag << "] " << who << ": memory error at 0x" << std::hex
              << e.address() << std::dec << " (" << e.reason() << ")" << std::endl;
}

#endif // MKW_RUNTIME_LOG_H
