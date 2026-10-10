// WebAssembly streamed trees (disc + mod pack): manifest-driven directory queries and
// JSPI-awaited HTTP Range reads behind a shared LRU block cache. See
// runtime/include/hle/web_disc.h for the contract and web/js/library_mkw_dvd.js for the JS
// imports. Native builds compile this file to nothing.
#ifdef __EMSCRIPTEN__

#include "hle/web_disc.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <list>
#include <map>
#include <unordered_map>
#include <unordered_set>
#include <utility>

extern "C" {
// Imports from web/js/library_mkw_dvd.js; `mount` is a WebDisc::Mount value.
//
// JSPI-suspending. Fetches the mount's manifest and returns a malloc'd, NUL-terminated listing
// the caller frees: "MKWDISC\t1\t<base URL>\n" then "F\t<size>\t<path>\n" / "D\t<path>\n"
// lines, or "ERROR\t<message>\n". Never returns null except on allocation failure.
char* mkw_dvd_load_manifest(int mount);
// JSPI-suspending. Reads [offset, offset + length) of a mount-relative path into dest. Returns
// the number of bytes stored (less than length only at the server's end of file), or a
// negative code: -1 not found (HTTP 404/410), -2 request failed after retries, -3 malformed
// response.
int32_t mkw_dvd_read(int mount, const char* relPath, double offset, uint32_t length,
                     uint8_t* dest);
// Synchronous. The page's mod mount name (last segment of Module.mkwProduct.modRoot, e.g.
// "RetroRewind6") as a malloc'd string the caller frees, or null when there is none.
char* mkw_dvd_mod_mount_name(void);
}

namespace WebDisc {
namespace {

struct FileRecord {
    std::string path;
    uint64_t size = 0;
};

struct CachedBlock {
    uint64_t key = 0;
    std::vector<uint8_t> data;
};

constexpr size_t kMountCount = 2;

struct Tree {
    bool loaded = false;
    bool loading = false;
    bool failed = false;
    std::string error;
    std::string baseUrl;

    std::vector<FileRecord> files; // sorted by path (byte order)
    std::unordered_map<std::string, uint32_t> fileByPath;
    std::unordered_map<std::string, uint32_t> fileByLowerPath;
    std::unordered_set<std::string> directories; // canonical paths, "" is the root
    std::unordered_map<std::string, std::string> directoryByLowerPath;
};

struct State {
    Tree trees[kMountCount];
    bool modRootResolved = false;
    std::optional<std::filesystem::path> modRoot;

    size_t budget = kDefaultCacheBudget;
    std::list<CachedBlock> lru; // front = most recently used
    std::unordered_map<uint64_t, std::list<CachedBlock>::iterator> cache;
    Stats stats;
};

State& S() {
    static State state;
    return state;
}

Tree& T(Mount mount) {
    return S().trees[static_cast<size_t>(mount)];
}

const char* MountName(Mount mount) {
    return mount == Mount::Disc ? "disc" : "mod";
}

std::string Lower(std::string text) {
    std::transform(text.begin(), text.end(), text.begin(),
                   [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    return text;
}

// "files//Race/./x.szs/" -> "files/Race/x.szs"; ".." pops. Leading slashes are ignored.
std::string NormalizeRelative(const std::string& input) {
    std::vector<std::string> parts;
    size_t cursor = 0;
    while (cursor <= input.size()) {
        size_t end = input.find_first_of("/\\", cursor);
        if (end == std::string::npos) {
            end = input.size();
        }
        const std::string part = input.substr(cursor, end - cursor);
        if (part == "..") {
            if (!parts.empty()) {
                parts.pop_back();
            }
        } else if (!part.empty() && part != ".") {
            parts.push_back(part);
        }
        cursor = end + 1;
    }
    std::string joined;
    for (const std::string& part : parts) {
        if (!joined.empty()) {
            joined.push_back('/');
        }
        joined += part;
    }
    return joined;
}

void AddDirectory(Tree& state, const std::string& path) {
    if (state.directories.insert(path).second) {
        state.directoryByLowerPath.emplace(Lower(path), path);
    }
}

bool Fail(Tree& state, std::string message, std::string* error) {
    state.failed = true;
    state.error = std::move(message);
    std::fprintf(stderr, "[dvd/web] ERROR: %s\n", state.error.c_str());
    if (error) {
        *error = state.error;
    }
    return false;
}

bool ParseListing(Tree& state, const char* text, std::string* error) {
    const char* cursor = text;
    bool header = true;
    std::map<std::string, uint64_t> files;
    while (*cursor) {
        const char* lineEnd = std::strchr(cursor, '\n');
        const size_t length = lineEnd ? static_cast<size_t>(lineEnd - cursor) : std::strlen(cursor);
        const std::string line(cursor, length);
        cursor += length + (lineEnd ? 1 : 0);
        if (line.empty()) {
            continue;
        }

        if (header) {
            header = false;
            if (line.rfind("ERROR\t", 0) == 0) {
                return Fail(state, line.substr(6), error);
            }
            if (line.rfind("MKWDISC\t1\t", 0) != 0) {
                return Fail(state, "unrecognized disc manifest listing", error);
            }
            state.baseUrl = line.substr(10);
            continue;
        }

        if (line.rfind("D\t", 0) == 0) {
            const std::string path = NormalizeRelative(line.substr(2));
            AddDirectory(state, path);
            continue;
        }
        if (line.rfind("F\t", 0) == 0) {
            const size_t tab = line.find('\t', 2);
            if (tab == std::string::npos) {
                return Fail(state, "malformed disc manifest file entry: " + line, error);
            }
            char* end = nullptr;
            const std::string sizeText = line.substr(2, tab - 2);
            const unsigned long long size = std::strtoull(sizeText.c_str(), &end, 10);
            const std::string path = NormalizeRelative(line.substr(tab + 1));
            if (sizeText.empty() || !end || *end != '\0' || path.empty()) {
                return Fail(state, "malformed disc manifest file entry: " + line, error);
            }
            files[path] = size;
            continue;
        }
        return Fail(state, "malformed disc manifest line: " + line, error);
    }
    if (header) {
        return Fail(state, "empty disc manifest listing", error);
    }

    AddDirectory(state, "");
    state.files.reserve(files.size());
    for (const auto& [path, size] : files) {
        const uint32_t index = static_cast<uint32_t>(state.files.size());
        state.files.push_back({path, size});
        state.fileByPath.emplace(path, index);
        state.fileByLowerPath.emplace(Lower(path), index);
        for (size_t slash = path.find('/'); slash != std::string::npos;
             slash = path.find('/', slash + 1)) {
            AddDirectory(state, path.substr(0, slash));
        }
    }
    for (const FileRecord& file : state.files) {
        if (state.directories.count(file.path)) {
            return Fail(state, "disc manifest path is both a file and a directory: " + file.path,
                        error);
        }
    }
    return true;
}

const FileRecord* FindFile(Mount mount, const std::string& relPath, uint32_t* indexOut = nullptr) {
    Tree& state = T(mount);
    const std::string path = NormalizeRelative(relPath);
    auto it = state.fileByPath.find(path);
    if (it == state.fileByPath.end()) {
        it = state.fileByLowerPath.find(Lower(path));
        if (it == state.fileByLowerPath.end()) {
            return nullptr;
        }
    }
    if (indexOut) {
        *indexOut = it->second;
    }
    return &state.files[it->second];
}

std::optional<std::string> FindDirectory(Mount mount, const std::string& relPath) {
    Tree& state = T(mount);
    const std::string path = NormalizeRelative(relPath);
    if (state.directories.count(path)) {
        return path;
    }
    const auto it = state.directoryByLowerPath.find(Lower(path));
    if (it == state.directoryByLowerPath.end()) {
        return std::nullopt;
    }
    return it->second;
}

void EvictToBudget(State& state) {
    while (state.stats.cachedBytes > state.budget && !state.lru.empty()) {
        CachedBlock& victim = state.lru.back();
        state.stats.cachedBytes -= victim.data.size();
        state.cache.erase(victim.key);
        state.lru.pop_back();
        ++state.stats.evictions;
    }
}

ReadStatus StatusForFetchError(int32_t code, const FileRecord& file, uint64_t offset,
                               uint32_t length) {
    std::fprintf(stderr, "[dvd/web] read failed: %s offset=%llu length=%u code=%d\n",
                 file.path.c_str(), static_cast<unsigned long long>(offset), length, code);
    return ReadStatus::MissingFile;
}

} // namespace

const std::filesystem::path& RootPath() {
    static const std::filesystem::path root("/disc");
    return root;
}

std::optional<std::filesystem::path> ModRootPath() {
    State& state = S();
    if (!state.modRootResolved) {
        state.modRootResolved = true;
        if (char* name = mkw_dvd_mod_mount_name()) {
            const std::string text = name;
            std::free(name);
            if (!text.empty() && text != "." && text != ".." &&
                text.find_first_of("/\\") == std::string::npos) {
                state.modRoot = std::filesystem::path("/mods") / text;
            }
        }
    }
    return state.modRoot;
}

std::optional<Location> Locate(const std::filesystem::path& hostPath) {
    const std::string text = hostPath.lexically_normal().generic_string();
    const auto under = [&text](const std::filesystem::path& root) -> std::optional<std::string> {
        const std::string rootText = root.generic_string();
        if (text == rootText || text == rootText + "/") {
            return std::string();
        }
        if (text.size() <= rootText.size() || text.compare(0, rootText.size(), rootText) != 0 ||
            text[rootText.size()] != '/') {
            return std::nullopt;
        }
        return NormalizeRelative(text.substr(rootText.size() + 1));
    };
    if (auto rel = under(RootPath())) {
        return Location{Mount::Disc, std::move(*rel)};
    }
    if (const auto modRoot = ModRootPath()) {
        if (auto rel = under(*modRoot)) {
            return Location{Mount::Mod, std::move(*rel)};
        }
    }
    return std::nullopt;
}

bool EnsureLoaded(Mount mount, std::string* error) {
    Tree& state = T(mount);
    if (state.loaded) {
        return true;
    }
    if (state.failed) {
        if (error) {
            *error = state.error;
        }
        return false;
    }
    if (state.loading) {
        // Only reachable if wasm were re-entered from a JS callback while the manifest fetch
        // is suspended, which the web build never does.
        if (error) {
            *error = std::string(MountName(mount)) + " manifest load re-entered";
        }
        return false;
    }

    state.loading = true;
    char* listing = mkw_dvd_load_manifest(static_cast<int>(mount));
    state.loading = false;
    if (!listing) {
        return Fail(state, "out of memory while loading a manifest", error);
    }
    const bool ok = ParseListing(state, listing, error);
    std::free(listing);
    if (!ok) {
        return false;
    }
    state.loaded = true;
    std::fprintf(stderr, "[dvd/web] %s manifest: %zu file(s), %zu director(ies) at %s\n",
                 MountName(mount), state.files.size(), state.directories.size(),
                 state.baseUrl.c_str());
    return true;
}

const std::string& BaseUrl(Mount mount) {
    return T(mount).baseUrl;
}

bool IsDataRoot() {
    return EnsureLoaded(Mount::Disc) && IsDirectory(Mount::Disc, "files") &&
           FileSize(Mount::Disc, "sys/fst.bin").has_value();
}

std::optional<std::string> RelativePath(const std::filesystem::path& hostPath) {
    const auto location = Locate(hostPath);
    if (!location || location->mount != Mount::Disc) {
        return std::nullopt;
    }
    return location->relPath;
}

std::optional<uint64_t> FileSize(Mount mount, const std::string& relPath) {
    if (!EnsureLoaded(mount)) {
        return std::nullopt;
    }
    const FileRecord* file = FindFile(mount, relPath);
    if (!file) {
        return std::nullopt;
    }
    return file->size;
}

bool IsDirectory(Mount mount, const std::string& relPath) {
    return EnsureLoaded(mount) && FindDirectory(mount, relPath).has_value();
}

void ForEachFile(Mount mount, const std::string& relDir, bool recursive, const FileVisitor& visit) {
    if (!EnsureLoaded(mount)) {
        return;
    }
    const std::optional<std::string> directory = FindDirectory(mount, relDir);
    if (!directory) {
        return;
    }
    const std::string prefix = directory->empty() ? std::string() : *directory + "/";
    const std::vector<FileRecord>& files = T(mount).files;
    auto it = std::lower_bound(files.begin(), files.end(), prefix,
                               [](const FileRecord& file, const std::string& value) {
                                   return file.path < value;
                               });
    for (; it != files.end() && it->path.compare(0, prefix.size(), prefix) == 0; ++it) {
        const std::string below = it->path.substr(prefix.size());
        if (!recursive && below.find('/') != std::string::npos) {
            continue;
        }
        visit(below, it->path, it->size);
    }
}

ReadStatus Read(Mount mount, const std::string& relPath, uint64_t offset, uint32_t length,
                std::vector<uint8_t>& destination) {
    if (!EnsureLoaded(mount)) {
        return ReadStatus::MissingFile;
    }
    State& state = S();
    uint32_t fileIndex = 0;
    const FileRecord* file = FindFile(mount, relPath, &fileIndex);
    if (!file) {
        return ReadStatus::MissingFile;
    }
    if (offset >= file->size) {
        return ReadStatus::BadOffset;
    }
    if (length > file->size - offset) {
        return ReadStatus::ShortRead;
    }

    std::vector<uint8_t> staged(length);
    if (length == 0) {
        destination = std::move(staged);
        return ReadStatus::Ok;
    }

    const uint64_t firstBlock = offset / kBlockSize;
    const uint64_t lastBlock = (offset + length - 1) / kBlockSize;
    const uint64_t blockCount = lastBlock - firstBlock + 1;
    // Blocks of a <= 4 GiB file fit 16 bits; mount and file index take the rest.
    const auto keyFor = [mount, fileIndex](uint64_t block) {
        return (static_cast<uint64_t>(mount) << 62) | (static_cast<uint64_t>(fileIndex) << 16) |
               block;
    };

    // Pointers stay valid until the eviction pass at the end: list splices do not move
    // elements and nothing is erased before the copy-out.
    std::vector<const std::vector<uint8_t>*> sources(blockCount, nullptr);
    std::map<uint64_t, std::vector<uint8_t>> fetched;
    for (uint64_t block = firstBlock; block <= lastBlock; ++block) {
        const auto hit = state.cache.find(keyFor(block));
        if (hit != state.cache.end()) {
            state.lru.splice(state.lru.begin(), state.lru, hit->second);
            sources[block - firstBlock] = &hit->second->data;
            ++state.stats.blockHits;
        } else {
            ++state.stats.blockMisses;
        }
    }

    constexpr uint64_t kMaxBlocksPerRequest = kMaxRequestBytes / kBlockSize;
    uint64_t block = firstBlock;
    while (block <= lastBlock) {
        if (sources[block - firstBlock]) {
            ++block;
            continue;
        }
        uint64_t runEnd = block; // inclusive
        while (runEnd + 1 <= lastBlock && !sources[runEnd + 1 - firstBlock] &&
               runEnd + 1 - block < kMaxBlocksPerRequest) {
            ++runEnd;
        }
        const uint64_t start = block * kBlockSize;
        const uint64_t end = std::min<uint64_t>((runEnd + 1) * kBlockSize, file->size);
        const uint32_t requestLength = static_cast<uint32_t>(end - start);
        std::vector<uint8_t> buffer(requestLength);
        ++state.stats.requests;
        const int32_t received = mkw_dvd_read(static_cast<int>(mount), file->path.c_str(),
                                              static_cast<double>(start), requestLength,
                                              buffer.data());
        if (received < 0) {
            return StatusForFetchError(received, *file, start, requestLength);
        }
        state.stats.bytesFetched += static_cast<uint64_t>(received);
        if (static_cast<uint32_t>(received) < requestLength) {
            std::fprintf(stderr,
                         "[dvd/web] %s: server returned %d of %u bytes at offset %llu "
                         "(file shorter than the manifest says)\n",
                         file->path.c_str(), received, requestLength,
                         static_cast<unsigned long long>(start));
            return ReadStatus::ShortRead;
        }
        for (uint64_t b = block; b <= runEnd; ++b) {
            const uint64_t blockStart = (b - block) * kBlockSize;
            const uint64_t blockEnd = std::min<uint64_t>(blockStart + kBlockSize, requestLength);
            auto& data = fetched[b];
            data.assign(buffer.begin() + static_cast<std::ptrdiff_t>(blockStart),
                        buffer.begin() + static_cast<std::ptrdiff_t>(blockEnd));
            sources[b - firstBlock] = &data;
        }
        block = runEnd + 1;
    }

    for (uint64_t b = firstBlock; b <= lastBlock; ++b) {
        const std::vector<uint8_t>& data = *sources[b - firstBlock];
        const uint64_t blockStart = b * kBlockSize;
        const uint64_t copyStart = std::max(offset, blockStart);
        const uint64_t copyEnd = std::min(offset + length, blockStart + data.size());
        if (copyEnd > copyStart) {
            std::memcpy(staged.data() + (copyStart - offset), data.data() + (copyStart - blockStart),
                        static_cast<size_t>(copyEnd - copyStart));
        }
    }

    if (state.budget != 0) {
        for (auto& [b, data] : fetched) {
            if (data.size() > state.budget) {
                continue;
            }
            state.stats.cachedBytes += data.size();
            state.lru.push_front({keyFor(b), std::move(data)});
            state.cache[keyFor(b)] = state.lru.begin();
        }
        EvictToBudget(state);
    }

    destination = std::move(staged);
    return ReadStatus::Ok;
}

bool ReadWhole(Mount mount, const std::string& relPath, std::vector<uint8_t>& destination) {
    const std::optional<uint64_t> size = FileSize(mount, relPath);
    if (!size || *size > UINT32_MAX) {
        return false;
    }
    if (*size == 0) {
        destination.clear();
        return true;
    }
    return Read(mount, relPath, 0, static_cast<uint32_t>(*size), destination) == ReadStatus::Ok;
}

Stats GetStats() {
    return S().stats;
}

void SetCacheBudget(size_t bytes) {
    State& state = S();
    state.budget = bytes;
    EvictToBudget(state);
}

void ClearCache() {
    State& state = S();
    state.lru.clear();
    state.cache.clear();
    state.stats.cachedBytes = 0;
}

} // namespace WebDisc

#endif // __EMSCRIPTEN__
