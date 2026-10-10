// Streamed read-only trees for the WebAssembly build (implementation:
// runtime/src/hle/storage/web_disc.cpp, JS side: web/js/library_mkw_dvd.js).
//
// On the web there is no host filesystem holding the extracted disc or a mod pack. The operator
// publishes each tree next to the page with a build-time manifest
// (web/tools/make_disc_manifest.py) and the runtime sees it under a virtual host directory
// (a "mount"); nothing exists there in the Emscripten FS:
//   * Mount::Disc  "/disc"         the extracted DATA partition (`sys/`, `files/`), manifest
//                                  `disc-manifest.json`;
//   * Mount::Mod   "/mods/<name>"  the product's mod pack (Retro Rewind: `RetroRewind6/`) when the
//                                  page sets Module.mkwProduct.modRoot (e.g. 'mods/RetroRewind6',
//                                  manifest 'mods/RetroRewind6-manifest.json').
// Directory queries are answered from the manifest; reads become HTTP Range requests, awaited
// through JSPI, behind one shared in-memory LRU cache of fixed-size blocks. Each manifest is
// fetched lazily on the first query that touches its mount.
//
// Native builds never compile web_disc.cpp's body; use hle/web_host_fs.h for code that must
// stay a plain std::filesystem call natively.
#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace WebDisc {

enum class Mount : uint8_t {
    Disc = 0,
    Mod = 1,
};

// Mirrors DvdReadContract::HostReadFailure (which maps 1:1 onto it).
enum class ReadStatus : uint8_t {
    Ok,
    MissingFile, // not in the manifest, HTTP 404/410, or the request failed for good
    BadOffset,   // offset >= manifest size
    ShortRead,   // offset+length > manifest size, or the server returned fewer bytes
};

// A host path resolved to a mount and a mount-relative path ("" is the mount root).
struct Location {
    Mount mount = Mount::Disc;
    std::string relPath;
};

// Virtual host directory of the disc ("/disc").
const std::filesystem::path& RootPath();

// Virtual host directory of the page's mod pack ("/mods/<name>"), or nullopt when the page
// configured none. Cheap and synchronous (does not fetch the manifest).
std::optional<std::filesystem::path> ModRootPath();

// The mount and mount-relative path for a host path under any mount's root; nullopt otherwise.
// Purely lexical: does not load anything.
std::optional<Location> Locate(const std::filesystem::path& hostPath);

// Fetches and parses a mount's manifest once (JSPI-suspends the caller on the first call).
// On failure returns false and, if `error` is non-null, a human-readable reason; the mount then
// stays empty (every lookup misses) instead of retrying.
bool EnsureLoaded(Mount mount, std::string* error = nullptr);

// URL of the hosted tree (diagnostics only). Empty until loaded.
const std::string& BaseUrl(Mount mount);

// Manifest queries on mount-relative paths ("" is the root). Lookups are exact first, then
// ASCII case-insensitive (the guest's and Riivolution's own lookups are case-insensitive).
std::optional<uint64_t> FileSize(Mount mount, const std::string& relPath);
bool IsDirectory(Mount mount, const std::string& relPath);

// Visits every regular file under `relDir` (direct children only unless `recursive`) in
// manifest (byte-wise path) order. `relativeToDir` is the path below relDir ("Race/x.szs"),
// `relPath` the full mount-relative path.
using FileVisitor =
    std::function<void(const std::string& relativeToDir, const std::string& relPath, uint64_t size)>;
void ForEachFile(Mount mount, const std::string& relDir, bool recursive, const FileVisitor& visit);

// Exact-range read with DvdReadContract::ReadExact semantics: `destination` is replaced only on
// success (length 0 at a valid offset succeeds with an empty vector).
ReadStatus Read(Mount mount, const std::string& relPath, uint64_t offset, uint32_t length,
                std::vector<uint8_t>& destination);

// Whole-file read (XMLs, sys/fst.bin, RFLRes01.arc, ...).
bool ReadWhole(Mount mount, const std::string& relPath, std::vector<uint8_t>& destination);

// --- Disc-mount shorthands (the original single-mount API) --------------------------------
inline bool EnsureLoaded(std::string* error = nullptr) { return EnsureLoaded(Mount::Disc, error); }
inline const std::string& BaseUrl() { return BaseUrl(Mount::Disc); }
inline std::optional<uint64_t> FileSize(const std::string& relPath) { return FileSize(Mount::Disc, relPath); }
inline bool IsDirectory(const std::string& relPath) { return IsDirectory(Mount::Disc, relPath); }
inline void ForEachFile(const std::string& relDir, bool recursive, const FileVisitor& visit) {
    ForEachFile(Mount::Disc, relDir, recursive, visit);
}
inline ReadStatus Read(const std::string& relPath, uint64_t offset, uint32_t length,
                       std::vector<uint8_t>& destination) {
    return Read(Mount::Disc, relPath, offset, length, destination);
}
inline bool ReadWhole(const std::string& relPath, std::vector<uint8_t>& destination) {
    return ReadWhole(Mount::Disc, relPath, destination);
}

// True when the disc manifest describes an extracted DATA tree (`files/` and `sys/fst.bin`).
bool IsDataRoot();

// "files/Race/Course/x.szs" for "/disc/files/Race/Course/x.szs"; nullopt for paths that are
// not under RootPath() (disc mount only; see Locate for any mount).
std::optional<std::string> RelativePath(const std::filesystem::path& hostPath);

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

// Cache budget in bytes (0 disables caching), shared by all mounts. Shrinking evicts immediately.
void SetCacheBudget(size_t bytes);
void ClearCache();

} // namespace WebDisc
