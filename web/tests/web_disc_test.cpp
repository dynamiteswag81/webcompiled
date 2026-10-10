// Standalone check of the web disc layer (runtime/src/hle/storage/web_disc.cpp +
// web/js/library_mkw_dvd.js) and of the IDBFS save store, against a fake disc tree served over
// HTTP by web/tests/run_web_disc_test.mjs (which builds the tree, the manifest and the argv).
// Every disc read goes through DvdReadContract::ReadExact exactly like dvd.cpp's reads do.
//
// argv (all produced by the runner):
//   --file=<relPath>:<size>       every file the manifest lists (content = Expected(relPath))
//   --dir=<relPath>               a directory that must exist (e.g. an empty one)
//   --missing=<relPath>           in the manifest, but the server answers 404
//   --truncated=<relPath>:<size>  in the manifest, but the server only has <size> bytes
//   --norange=<relPath>           the server ignores Range for this file (sends 200 + body)
//   --persist=<none|write|verify|readonly|nolocks> IDBFS phase; --nonce=<text> ties the browser runs
//                                 together. write: first tab (owns the Web Lock) writes saves;
//                                 readonly: a second tab at the same time must be read-only;
//                                 verify: a later tab sees exactly what `write` stored (nothing from
//                                 `readonly`); nolocks: navigator.locks removed, old behaviour.
#include "hle/dvd_contract.h"
#include "hle/web_disc.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <set>
#include <string>
#include <vector>

extern "C" int mkw_storage_flush(void);
extern "C" int mkw_storage_is_persistent(void);
extern "C" int mkw_storage_is_readonly(void);

namespace {

int g_checks = 0;
int g_failures = 0;

#define CHECK(cond, ...)                                                   \
    do {                                                                   \
        ++g_checks;                                                        \
        if (!(cond)) {                                                     \
            ++g_failures;                                                  \
            std::printf("FAIL %s:%d: %s: ", __FILE__, __LINE__, #cond);    \
            std::printf(__VA_ARGS__);                                      \
            std::printf("\n");                                             \
        }                                                                  \
    } while (0)

// Same generator as the runner: xorshift32 seeded with FNV-1a(relPath) | 1, four
// little-endian bytes per step.
std::vector<uint8_t> Expected(const std::string& relPath, uint64_t size) {
    uint32_t state = 2166136261u;
    for (unsigned char ch : relPath) {
        state = (state ^ ch) * 16777619u;
    }
    state |= 1u;
    std::vector<uint8_t> bytes(size);
    for (uint64_t i = 0; i < size; i += 4) {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        for (uint64_t b = 0; b < 4 && i + b < size; ++b) {
            bytes[i + b] = static_cast<uint8_t>(state >> (8 * b));
        }
    }
    return bytes;
}

struct Rng {
    uint64_t s = 0x9E3779B97F4A7C15ull;
    uint64_t Next() {
        s ^= s << 7;
        s ^= s >> 9;
        return s;
    }
    uint64_t Below(uint64_t n) { return n ? Next() % n : 0; }
};

std::filesystem::path Host(const std::string& relPath) {
    return WebDisc::RootPath() / relPath;
}

using Failure = DvdReadContract::HostReadFailure;

bool Read(const std::string& relPath, uint64_t offset, uint32_t length, std::vector<uint8_t>& out,
          Failure& failure) {
    return DvdReadContract::ReadExact(Host(relPath), offset, length, out, failure);
}

bool Matches(const std::vector<uint8_t>& got, const std::vector<uint8_t>& whole, uint64_t offset) {
    return offset + got.size() <= whole.size() &&
           std::equal(got.begin(), got.end(), whole.begin() + static_cast<std::ptrdiff_t>(offset));
}

std::string Value(const std::string& arg, const char* key) {
    const size_t n = std::strlen(key);
    return arg.compare(0, n, key) == 0 ? arg.substr(n) : std::string();
}

std::pair<std::string, uint64_t> PathAndSize(const std::string& text) {
    const size_t colon = text.rfind(':');
    return {text.substr(0, colon), std::stoull(text.substr(colon + 1))};
}

bool WriteText(const std::string& path, const std::string& text) {
    std::filesystem::create_directories(std::filesystem::path(path).parent_path());
    FILE* file = std::fopen(path.c_str(), "wb");
    if (!file) return false;
    const bool ok = std::fwrite(text.data(), 1, text.size(), file) == text.size();
    return std::fclose(file) == 0 && ok;
}

std::string ReadText(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(in), {});
}

} // namespace

int main(int argc, char** argv) {
    std::map<std::string, uint64_t> files;
    std::set<std::string> dirs, missing, norange;
    std::map<std::string, uint64_t> truncated;
    std::string persist = "none", nonce;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (auto v = Value(arg, "--file="); !v.empty()) files.insert(PathAndSize(v));
        else if (auto v = Value(arg, "--dir="); !v.empty()) dirs.insert(v);
        else if (auto v = Value(arg, "--missing="); !v.empty()) missing.insert(v);
        else if (auto v = Value(arg, "--truncated="); !v.empty()) truncated.insert(PathAndSize(v));
        else if (auto v = Value(arg, "--norange="); !v.empty()) norange.insert(v);
        else if (auto v = Value(arg, "--persist="); !v.empty()) persist = v;
        else if (auto v = Value(arg, "--nonce="); !v.empty()) nonce = v;
        else {
            std::printf("FAIL: unknown argument %s\n", arg.c_str());
            return 1;
        }
    }
    if (files.empty()) {
        std::printf("FAIL: no --file arguments\n");
        return 1;
    }
    constexpr uint32_t B = WebDisc::kBlockSize;

    // --- Manifest -------------------------------------------------------------------------
    std::string error;
    CHECK(WebDisc::EnsureLoaded(&error), "%s", error.c_str());
    CHECK(WebDisc::IsDataRoot(), "fake tree should look like a DATA partition");
    std::printf("disc base URL: %s\n", WebDisc::BaseUrl().c_str());

    CHECK(WebDisc::RelativePath("/disc/files/a/b.szs") == std::optional<std::string>("files/a/b.szs"), "relpath");
    CHECK(WebDisc::RelativePath("/disc/sys/../files//x") == std::optional<std::string>("files/x"), "relpath normalize");
    CHECK(WebDisc::RelativePath("/disc") == std::optional<std::string>(""), "relpath root");
    CHECK(!WebDisc::RelativePath("/discs/files/x").has_value(), "relpath prefix");
    CHECK(!WebDisc::RelativePath("/home/web_user/x").has_value(), "relpath other");
    // This page configures no mod pack (Module.mkwProduct): there is no mod mount.
    CHECK(!WebDisc::ModRootPath().has_value(), "no mod mount without Module.mkwProduct.modRoot");
    CHECK(!WebDisc::Locate("/mods/RetroRewind6/x").has_value(), "no mod paths without a mod mount");
    {
        const auto location = WebDisc::Locate("/disc/sys/fst.bin");
        CHECK(location && location->mount == WebDisc::Mount::Disc && location->relPath == "sys/fst.bin", "Locate disc path");
    }

    // --- Manifest-driven listing -------------------------------------------------------------
    {
        std::map<std::string, uint64_t> listed;
        WebDisc::ForEachFile("", true, [&](const std::string& below, const std::string& rel, uint64_t size) {
            CHECK(below == rel, "root listing: %s vs %s", below.c_str(), rel.c_str());
            listed[rel] = size;
        });
        CHECK(listed == files, "recursive root listing has %zu entries, expected %zu", listed.size(), files.size());

        std::set<std::string> direct, expectDirect;
        WebDisc::ForEachFile("files", false, [&](const std::string& below, const std::string& rel, uint64_t) {
            direct.insert(below);
            CHECK(rel == "files/" + below, "direct listing rel %s", rel.c_str());
        });
        for (const auto& [path, size] : files) {
            if (path.rfind("files/", 0) == 0 && path.find('/', 6) == std::string::npos) {
                expectDirect.insert(path.substr(6));
            }
        }
        CHECK(direct == expectDirect, "non-recursive files/ listing: %zu vs %zu", direct.size(), expectDirect.size());

        std::set<std::string> race, expectRace;
        WebDisc::ForEachFile("/FILES/race/", true, [&](const std::string& below, const std::string&, uint64_t) {
            race.insert(below);
        });
        for (const auto& [path, size] : files) {
            if (path.rfind("files/Race/", 0) == 0) expectRace.insert(path.substr(11));
        }
        CHECK(!expectRace.empty() && race == expectRace, "case-insensitive subtree listing: %zu vs %zu", race.size(), expectRace.size());

        int none = 0;
        WebDisc::ForEachFile("files/does_not_exist", true, [&](auto&&...) { ++none; });
        CHECK(none == 0, "listing of a missing directory");
        for (const std::string& dir : dirs) {
            CHECK(WebDisc::IsDirectory(dir), "directory %s", dir.c_str());
        }
        CHECK(WebDisc::IsDirectory("") && WebDisc::IsDirectory("files") && WebDisc::IsDirectory("sys"), "top dirs");
        CHECK(WebDisc::IsDirectory("files/race/COURSE"), "case-insensitive directory");
        CHECK(!WebDisc::IsDirectory("files/tiny.bin"), "file is not a directory");
        CHECK(!WebDisc::IsDirectory("files/nope"), "missing directory");
        for (const auto& [path, size] : files) {
            CHECK(WebDisc::FileSize(path) == std::optional<uint64_t>(size), "size of %s", path.c_str());
        }
        std::string upper = files.rbegin()->first;
        std::transform(upper.begin(), upper.end(), upper.begin(), ::toupper);
        CHECK(WebDisc::FileSize(upper).has_value(), "case-insensitive file lookup %s", upper.c_str());
        CHECK(!WebDisc::FileSize("files/nope.bin").has_value(), "missing file size");
    }

    // --- Whole-file reads (everything the server really has) -----------------------------------
    for (const auto& [path, size] : files) {
        if (missing.count(path) || truncated.count(path) || size == 0) continue;
        const std::vector<uint8_t> whole = Expected(path, size);
        std::vector<uint8_t> got;
        Failure failure;
        const bool ok = Read(path, 0, static_cast<uint32_t>(size), got, failure);
        CHECK(ok && got == whole, "whole read of %s (%llu bytes): %s", path.c_str(),
              static_cast<unsigned long long>(size), DvdReadContract::Describe(failure));
    }

    // --- Random-offset reads -------------------------------------------------------------------
    {
        std::vector<std::pair<std::string, uint64_t>> readable;
        for (const auto& [path, size] : files) {
            if (!missing.count(path) && !truncated.count(path) && size > 0) readable.push_back({path, size});
        }
        std::map<std::string, std::vector<uint8_t>> wholes;
        for (const auto& [path, size] : readable) wholes[path] = Expected(path, size);
        // A cold, tiny cache so the random reads really go to the network and evict.
        WebDisc::ClearCache();
        WebDisc::SetCacheBudget(4 * B);
        const auto before = WebDisc::GetStats();
        Rng rng;
        int bad = 0;
        for (int i = 0; i < 400; ++i) {
            const auto& [path, size] = readable[rng.Below(readable.size())];
            const uint64_t offset = rng.Below(size);
            // Mostly small reads, some multi-block ones.
            const uint64_t maxLen = (i % 5 == 0) ? std::min<uint64_t>(size - offset, 3ull * B) : std::min<uint64_t>(size - offset, 0x9000);
            const uint32_t length = static_cast<uint32_t>(rng.Below(maxLen + 1));
            std::vector<uint8_t> got;
            Failure failure;
            if (!Read(path, offset, length, got, failure) || got.size() != length || !Matches(got, wholes[path], offset)) {
                if (++bad <= 5) {
                    std::printf("  random read %s @%llu +%u failed: %s\n", path.c_str(),
                                static_cast<unsigned long long>(offset), length, DvdReadContract::Describe(failure));
                }
            }
        }
        CHECK(bad == 0, "%d of 400 random reads failed", bad);
        const auto after = WebDisc::GetStats();
        std::printf("random reads: %llu requests, %llu hits, %llu misses, %llu evictions\n",
                    (unsigned long long)(after.requests - before.requests),
                    (unsigned long long)(after.blockHits - before.blockHits),
                    (unsigned long long)(after.blockMisses - before.blockMisses),
                    (unsigned long long)(after.evictions - before.evictions));
        CHECK(after.requests - before.requests > 100 && after.evictions > before.evictions,
              "random reads should miss and evict under a 4-block budget");
        WebDisc::SetCacheBudget(WebDisc::kDefaultCacheBudget);
    }

    // --- Cross-block, EOF and error contract ---------------------------------------------------
    std::string bigFile;
    for (const auto& [path, size] : files) {
        if (!missing.count(path) && !truncated.count(path) && !norange.count(path) && size > 3ull * B &&
            size < WebDisc::kMaxRequestBytes) {
            bigFile = path;
        }
    }
    CHECK(!bigFile.empty(), "need a multi-block file");
    if (!bigFile.empty()) {
        const uint64_t size = files[bigFile];
        const std::vector<uint8_t> whole = Expected(bigFile, size);
        std::vector<uint8_t> got;
        Failure failure;
        CHECK(Read(bigFile, B - 10, 20, got, failure) && Matches(got, whole, B - 10) && got.size() == 20, "block seam read");
        CHECK(Read(bigFile, 2ull * B - 1, B + 2, got, failure) && Matches(got, whole, 2ull * B - 1) && got.size() == B + 2, "three-block read");
        CHECK(Read(bigFile, size - 1, 1, got, failure) && got.size() == 1 && got[0] == whole.back(), "last byte");
        CHECK(Read(bigFile, 7, 0, got, failure) && got.empty(), "zero-length read");

        const std::vector<uint8_t> sentinel{1, 2, 3};
        got = sentinel;
        CHECK(!Read(bigFile, size, 0, got, failure) && failure == Failure::BadOffset && got == sentinel, "offset == size -> BadOffset");
        CHECK(!Read(bigFile, size + 100, 4, got, failure) && failure == Failure::BadOffset && got == sentinel, "offset > size -> BadOffset");
        CHECK(!Read(bigFile, size - 5, 10, got, failure) && failure == Failure::ShortRead && got == sentinel, "past EOF -> ShortRead");
    }
    {
        std::vector<uint8_t> got{9};
        Failure failure;
        for (const auto& [path, size] : files) {
            if (size == 0) {
                CHECK(!Read(path, 0, 0, got, failure) && failure == Failure::BadOffset, "empty file %s -> BadOffset (native parity)", path.c_str());
            }
        }
        const uint64_t requestsBefore = WebDisc::GetStats().requests;
        CHECK(!Read("files/not_in_manifest.bin", 0, 1, got, failure) && failure == Failure::MissingFile, "unknown path -> MissingFile");
        CHECK(WebDisc::GetStats().requests == requestsBefore, "unknown path must not hit the network");
        for (const std::string& path : missing) {
            CHECK(!Read(path, 0, 1, got, failure) && failure == Failure::MissingFile, "404 %s -> MissingFile", path.c_str());
        }
        for (const auto& [path, actual] : truncated) {
            const std::vector<uint8_t> head = Expected(path, files[path]);
            CHECK(Read(path, 100, 1000, got, failure) && Matches(got, head, 100), "truncated %s: bytes that exist", path.c_str());
            CHECK(!Read(path, actual + 10, 100, got, failure) && failure == Failure::ShortRead, "truncated %s: missing tail -> ShortRead", path.c_str());
        }
        // A host path outside the disc root still reads the Emscripten FS (overlay semantics).
        CHECK(WriteText("/tmp/overlay/file.bin", "overlay-bytes"), "write MEMFS file");
        CHECK(DvdReadContract::ReadExact("/tmp/overlay/file.bin", 8, 5, got, failure) &&
                  std::string(got.begin(), got.end()) == "bytes", "non-disc path goes through the FS");
    }

    // --- Cache behavior ------------------------------------------------------------------------
    if (!bigFile.empty()) {
        const uint64_t size = files[bigFile];
        const std::vector<uint8_t> whole = Expected(bigFile, size);
        std::vector<uint8_t> got;
        Failure failure;
        WebDisc::ClearCache();
        auto s0 = WebDisc::GetStats();
        CHECK(Read(bigFile, 100, 1000, got, failure) && Matches(got, whole, 100), "cold read");
        auto s1 = WebDisc::GetStats();
        CHECK(s1.requests == s0.requests + 1 && s1.blockMisses == s0.blockMisses + 1, "cold read: one request, one miss");
        CHECK(Read(bigFile, 500, 2000, got, failure) && Matches(got, whole, 500), "warm read");
        auto s2 = WebDisc::GetStats();
        CHECK(s2.requests == s1.requests && s2.blockHits == s1.blockHits + 1, "warm read is a cache hit");
        // Block 0 cached, blocks 1..3 missing -> one coalesced request.
        CHECK(Read(bigFile, 10, 3 * B, got, failure) && Matches(got, whole, 10), "partly cached read");
        auto s3 = WebDisc::GetStats();
        CHECK(s3.requests == s2.requests + 1 && s3.blockHits == s2.blockHits + 1 && s3.blockMisses == s2.blockMisses + 3,
              "coalesced run: requests +%llu hits +%llu misses +%llu",
              (unsigned long long)(s3.requests - s2.requests), (unsigned long long)(s3.blockHits - s2.blockHits),
              (unsigned long long)(s3.blockMisses - s2.blockMisses));
        // Holes: cache only block 1 of a fresh cache, then read blocks 0..2 -> two requests.
        WebDisc::ClearCache();
        CHECK(Read(bigFile, B + 5, 10, got, failure), "prime block 1");
        auto s4 = WebDisc::GetStats();
        CHECK(Read(bigFile, 0, 3 * B, got, failure) && Matches(got, whole, 0), "read around a cached block");
        auto s5 = WebDisc::GetStats();
        CHECK(s5.requests == s4.requests + 2 && s5.blockHits == s4.blockHits + 1, "hole read: two requests, one hit");
        CHECK(s5.cachedBytes == 3ull * B, "three blocks cached (%llu bytes)", (unsigned long long)s5.cachedBytes);

        // LRU eviction under a two-block budget.
        WebDisc::ClearCache();
        WebDisc::SetCacheBudget(2 * B);
        for (uint64_t block = 0; block < 3; ++block) {
            CHECK(Read(bigFile, block * B, 16, got, failure) && Matches(got, whole, block * B), "fill block %llu", (unsigned long long)block);
        }
        auto s6 = WebDisc::GetStats();
        CHECK(s6.cachedBytes <= 2ull * B && s6.evictions >= s5.evictions + 1, "evicted down to budget");
        CHECK(Read(bigFile, 2 * B, 16, got, failure), "most recent block");
        auto s7 = WebDisc::GetStats();
        CHECK(s7.requests == s6.requests, "most recent block still cached");
        CHECK(Read(bigFile, 0, 16, got, failure) && Matches(got, whole, 0), "oldest block");
        auto s8 = WebDisc::GetStats();
        CHECK(s8.requests == s7.requests + 1, "oldest block was evicted");
        WebDisc::SetCacheBudget(0);
        CHECK(WebDisc::GetStats().cachedBytes == 0, "budget 0 empties the cache");
        CHECK(Read(bigFile, 0, 16, got, failure) && WebDisc::GetStats().cachedBytes == 0, "budget 0 caches nothing");
        WebDisc::SetCacheBudget(WebDisc::kDefaultCacheBudget);
    }

    // Reads longer than kMaxRequestBytes are split into several requests.
    for (const auto& [path, size] : files) {
        if (size <= WebDisc::kMaxRequestBytes || missing.count(path) || truncated.count(path)) continue;
        WebDisc::ClearCache();
        const auto before = WebDisc::GetStats();
        std::vector<uint8_t> got;
        Failure failure;
        CHECK(Read(path, 0, static_cast<uint32_t>(size), got, failure) && got == Expected(path, size), "huge read %s", path.c_str());
        const auto after = WebDisc::GetStats();
        const uint64_t expectRequests = (size + WebDisc::kMaxRequestBytes - 1) / WebDisc::kMaxRequestBytes;
        CHECK(after.requests - before.requests == expectRequests, "huge read used %llu requests, expected %llu",
              (unsigned long long)(after.requests - before.requests), (unsigned long long)expectRequests);
        std::vector<uint8_t> whole;
        CHECK(WebDisc::ReadWhole(path, whole) && whole.size() == size, "ReadWhole %s", path.c_str());
    }

    // --- Save store (IDBFS) --------------------------------------------------------------------
    const std::string home = "/home/web_user/.local/share/web_disc_test";
    const std::string flushedPath = home + "/flushed.txt";
    const std::string autosavedPath = home + "/autosaved.txt";
    const std::string roPath = home + "/readonly-tab.txt";
    if (persist == "none") {
        CHECK(mkw_storage_is_persistent() == 0, "no IndexedDB here: saves stay in memory");
        CHECK(mkw_storage_is_readonly() == 0, "no IndexedDB here: not read-only either");
        CHECK(mkw_storage_flush() == 0, "flush without a persistent store reports 0");
    } else if (persist == "write") {
        CHECK(mkw_storage_is_persistent() == 1, "IDBFS should be mounted at /home/web_user");
        CHECK(mkw_storage_is_readonly() == 0, "the first tab owns the save store");
        CHECK(WriteText(flushedPath, "flushed-" + nonce), "write flushed file");
        CHECK(mkw_storage_flush() == 1, "explicit flush");
        // Not flushed explicitly: IDBFS autoPersist must store it once the event loop runs.
        CHECK(WriteText(autosavedPath, "auto-" + nonce), "write autosaved file");
        std::printf("IDBFS: wrote save files\n");
    } else if (persist == "readonly") {
        // Another tab (persist=write) is alive and holds the lock: this tab sees its saves but
        // must never write anything back.
        CHECK(mkw_storage_is_persistent() == 0, "second tab must not persist");
        CHECK(mkw_storage_is_readonly() == 1, "second tab must be read-only");
        CHECK(ReadText(flushedPath) == "flushed-" + nonce, "read-only tab still sees the saves: '%s'", ReadText(flushedPath).c_str());
        CHECK(ReadText(autosavedPath) == "auto-" + nonce, "read-only tab sees autosaved file: '%s'", ReadText(autosavedPath).c_str());
        // Writes that would clobber the owner's saves, and a new file; flush must refuse.
        CHECK(WriteText(flushedPath, "TAMPERED-" + nonce), "read-only tab can still write in memory");
        CHECK(WriteText(roPath, "readonly-" + nonce), "write file in the read-only tab");
        CHECK(mkw_storage_flush() == 0, "flush in a read-only tab reports 0");
        std::printf("IDBFS: read-only tab wrote in memory only\n");
    } else if (persist == "verify") {
        CHECK(mkw_storage_is_persistent() == 1, "IDBFS should be mounted at /home/web_user");
        CHECK(mkw_storage_is_readonly() == 0, "after the other tabs closed this one owns the save store");
        CHECK(ReadText(flushedPath) == "flushed-" + nonce, "flushed file survived reload: '%s'", ReadText(flushedPath).c_str());
        CHECK(ReadText(autosavedPath) == "auto-" + nonce, "autosaved file survived reload: '%s'", ReadText(autosavedPath).c_str());
        CHECK(!std::filesystem::exists(roPath), "a read-only tab must not have written readonly-tab.txt");
        std::printf("IDBFS: save files persisted across reload\n");
    } else if (persist == "nolocks") {
        // The page removed navigator.locks: behave like before, persistent and writable.
        CHECK(mkw_storage_is_persistent() == 1, "without Web Locks the store is still persistent");
        CHECK(mkw_storage_is_readonly() == 0, "without Web Locks nothing is read-only");
        CHECK(ReadText(flushedPath) == "flushed-" + nonce, "saves visible without Web Locks: '%s'", ReadText(flushedPath).c_str());
        std::printf("IDBFS: no Web Locks, persistent as before\n");
    }

    const auto stats = WebDisc::GetStats();
    std::printf("stats: requests=%llu fetched=%llu hits=%llu misses=%llu evictions=%llu\n",
                (unsigned long long)stats.requests, (unsigned long long)stats.bytesFetched,
                (unsigned long long)stats.blockHits, (unsigned long long)stats.blockMisses,
                (unsigned long long)stats.evictions);
    if (g_failures) {
        std::printf("FAIL web disc test (%d of %d checks failed)\n", g_failures, g_checks);
        return 1;
    }
    std::printf("PASS web disc test (%d checks, persist=%s)\n", g_checks, persist.c_str());
    return 0;
}
