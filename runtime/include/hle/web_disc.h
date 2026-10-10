// Disc access for the WebAssembly build (implementation: runtime/src/hle/storage/web_disc.cpp,
// JS side: web/js/library_mkw_dvd.js).
//
// On the web there is no host filesystem holding the extracted disc. The operator publishes the
// extracted DATA partition tree (`sys/`, `files/`) next to the page together with a build-time
// `disc-manifest.json` (web/tools/make_disc_manifest.py). The runtime sees that tree under the
// virtual host directory RootPath() ("/disc"); nothing exists there in the Emscripten FS:
//   * directory scans are answered from the manifest (ForEachFile/IsDirectory/FileSize);
//   * reads become HTTP Range requests, awaited through JSPI, behind an in-memory LRU cache of
//     fixed-size blocks.
//
// Native builds never compile web_disc.cpp's body and never include this header from code
// paths that run outside `#ifdef __EMSCRIPTEN__`.
#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace WebDisc {

// Mirrors DvdReadContract::HostReadFailure (which maps 1:1 onto it).
enum class ReadStatus : uint8_t {
    Ok,
    MissingFile, // not in the manifest, HTTP 404/410, or the request failed for good
    BadOffset,   // offset >= manifest size
    ShortRead,   // offset+length > manifest size, or the server returned fewer bytes
};

// Virtual host directory the hosted disc tree is mapped to ("/disc").
const std::filesystem::path& RootPath();

// Fetches and parses the manifest once (JSPI-suspends the calling stack on the first call).
// On failure returns false and, if `error` is non-null, a human-readable reason.
bool EnsureLoaded(std::string* error = nullptr);

// URL of the hosted disc tree (diagnostics only). Empty until loaded.
const std::string& BaseUrl();

// True when the manifest describes an extracted DATA tree (`files/` and `sys/fst.bin`).
bool IsDataRoot();

// "files/Race/Course/x.szs" for "/disc/files/Race/Course/x.szs"; nullopt for paths that are
// not under RootPath().
std::optional<std::string> RelativePath(const std::filesystem::path& hostPath);

// Manifest queries on disc-relative paths ("" is the root). Lookups are exact first, then
// ASCII case-insensitive (the guest's own lookups are case-insensitive).
std::optional<uint64_t> FileSize(const std::string& relPath);
bool IsDirectory(const std::string& relPath);

// Visits every regular file under `relDir` (direct children only unless `recursive`) in
// manifest (byte-wise path) order. `relativeToDir` is the path below relDir ("Race/x.szs"),
// `relPath` the full disc-relative path.
using FileVisitor =
    std::function<void(const std::string& relativeToDir, const std::string& relPath, uint64_t size)>;
void ForEachFile(const std::string& relDir, bool recursive, const FileVisitor& visit);

// Exact-range read with DvdReadContract::ReadExact semantics: `destination` is replaced only on
// success (length 0 at a valid offset succeeds with an empty vector).
ReadStatus Read(const std::string& relPath, uint64_t offset, uint32_t length,
                std::vector<uint8_t>& destination);

// Whole-file read (small files such as sys/fst.bin or RFLRes01.arc).
bool ReadWhole(const std::string& relPath, std::vector<uint8_t>& destination);

struct Stats {
    uint64_t blockHits = 0;     // blocks served from the cache
    uint64_t blockMisses = 0;   // blocks that had to be fetched
    uint64_t requests = 0;      // HTTP Range requests issued (after coalescing)
    uint64_t bytesFetched = 0;  // payload bytes received
    uint64_t cachedBytes = 0;   // bytes currently held by the cache
    uint64_t evictions = 0;     // blocks dropped by the LRU
};
Stats GetStats();

inline constexpr uint32_t kBlockSize = 256u * 1024u;
inline constexpr size_t kDefaultCacheBudget = size_t{64} * 1024u * 1024u;
// Largest single Range request; longer runs of missing blocks are split.
inline constexpr uint32_t kMaxRequestBytes = 16u * 1024u * 1024u;

// Cache budget in bytes (0 disables caching). Shrinking evicts immediately.
void SetCacheBudget(size_t bytes);
void ClearCache();

} // namespace WebDisc
