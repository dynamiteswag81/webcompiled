// Retro Rewind on the web, runtime side: the real riivolution.cpp (overlay discovery, XML ->
// mappings, <savegame> redirect) and the WebHostFs shim against a fake pack streamed as the
// WebDisc mod mount (/mods/RetroRewind6), plus ReadExact on the resulting mapping host paths.
// Driven by run_web_disc_test.mjs, which builds the pack below (keep the two in step):
//
//   RetroRewind6/xml/RetroRewind6.xml        the distribution-pinned XML (RecompMod stub below)
//   RetroRewind6/riivolution/Alt.xml, notes.txt
//   RetroRewind6/Scene/UI/MenuSingle_E.szs   <file>   -> /Scene/UI/MenuSingle_E.szs
//   RetroRewind6/Binaries/Code.pul           <file external="binaries/code.pul"> (wrong case)
//   RetroRewind6/Race/Course/*.szs, sub/*    <folder> -> /Race/Course (recursive, create)
//   RetroRewind6/ByName/Award.szs            <folder> without disc= (replace by file name)
//   RetroRewind6/Extras/extra.bin            only referenced by a disabled option
//
// argv: --pack (normal run) or --no-pack (the page names a mod whose manifest is missing).
#include "hle/dvd_contract.h"
#include "hle/storage/riivolution.h"
#include "hle/web_disc.h"
#include "hle/web_host_fs.h"
#include "memory.h"
#include "recomp_mod_loader.h"
#include "runtime_config.h"
#include "runtime_product.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace fs = std::filesystem;

// --- Link seams: what the product link provides, reduced to the Retro Rewind web setup -------
namespace RuntimeProduct {
const Descriptor& Active() noexcept {
    static constexpr Descriptor descriptor{Kind::RetroRewind, "Retro Rewind"};
    return descriptor;
}
} // namespace RuntimeProduct

namespace RuntimePlatform {
std::optional<fs::path> ExecutableDirectory() noexcept {
    return fs::path("/app");
}
} // namespace RuntimePlatform

namespace RecompMod {
// What the translator's generated mod TU registers for the retro-rewind profile
// (projects/mkwii/recomp.yml): the pack-relative overlay root resolved against the executable
// directory, the pinned XML and the pinned option choice.
const std::vector<fs::path>& DvdOverlayRoots() {
    static const std::vector<fs::path> roots{"/app/RetroRewind6"};
    return roots;
}
const std::string& RiivolutionXml() {
    static const std::string xml = "xml/RetroRewind6.xml";
    return xml;
}
const std::vector<RiivolutionOptionSelection>& RiivolutionOptionSelections() {
    static const std::vector<RiivolutionOptionSelection> selections{{"Retro Rewind", "Pack", 1}};
    return selections;
}
} // namespace RecompMod

// No guest memory: the game id falls back to RMCP01.
bool Memory::Contains(uint32_t, size_t) {
    return false;
}
namespace MemoryInline {
uint16_t Read16Slow(uint32_t) { return 0; }
uint32_t Read32Slow(uint32_t) { return 0; }
uintptr_t g_fullReadablePageBias[kPageCount] = {};
} // namespace MemoryInline

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

// Same generator as web_disc_test.cpp / the runner (seeded with the mount-relative path).
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

const RuntimeRiivolution::Mapping* FindMapping(const RuntimeRiivolution::PatchSet& set,
                                               RuntimeRiivolution::Mapping::Kind kind,
                                               const std::string& discPath) {
    for (const auto& mapping : set.mappings) {
        if (mapping.kind == kind && mapping.discPath == discPath) {
            return &mapping;
        }
    }
    return nullptr;
}

bool ReadsAs(const fs::path& hostPath, const std::string& seedPath) {
    std::error_code ec;
    const std::uintmax_t size = WebHostFs::FileSize(hostPath, ec);
    if (ec) {
        return false;
    }
    std::vector<uint8_t> got;
    DvdReadContract::HostReadFailure failure;
    return DvdReadContract::ReadExact(hostPath, 0, static_cast<uint32_t>(size), got, failure) &&
           got == Expected(seedPath, size);
}

} // namespace

int main(int argc, char** argv) {
    const bool expectPack = !(argc > 1 && std::strcmp(argv[1], "--no-pack") == 0);
    using Kind = RuntimeRiivolution::Mapping::Kind;
    const fs::path pack = "/mods/RetroRewind6";

    // The mount comes from Module.mkwProduct.modRoot; RetroRewindRoot() defaults to it.
    CHECK(WebDisc::ModRootPath() == std::optional<fs::path>(pack), "mod mount path");
    CHECK(RuntimeConfigFile::RetroRewindRoot() == pack.generic_string(), "RetroRewindRoot() = '%s'",
          RuntimeConfigFile::RetroRewindRoot().c_str());
    const auto located = WebDisc::Locate(pack / "Race" / "Course" / "x.szs");
    CHECK(located && located->mount == WebDisc::Mount::Mod && located->relPath == "Race/Course/x.szs", "Locate mod path");
    CHECK(!WebDisc::Locate("/mods/RetroRewind7/x").has_value() && !WebDisc::Locate("/mods").has_value(), "Locate outside the mount");

    if (!expectPack) {
        // Missing manifest: the mount is empty, the overlay root is rejected, nothing crashes.
        std::error_code ec;
        CHECK(!WebHostFs::IsDirectory(pack, ec), "missing pack is not a directory");
        CHECK(RuntimeRiivolution::Overlays().empty(), "no overlay without a pack");
        CHECK(!RuntimeRiivolution::GetSaveRedirect().has_value(), "no save redirect without a pack");
    } else {
        // --- WebHostFs on the mod mount --------------------------------------------------------
        std::error_code ec;
        CHECK(WebHostFs::IsDirectory(pack, ec) && !ec, "pack root is a directory");
        CHECK(WebHostFs::IsDirectory(pack / "riivolution", ec), "riivolution/ is a directory");
        CHECK(WebHostFs::IsDirectory(pack / "RACE" / "course", ec), "case-insensitive directory");
        CHECK(!WebHostFs::IsDirectory(pack / "nope", ec), "missing directory");
        CHECK(WebHostFs::IsRegularFile(pack / "xml" / "RetroRewind6.xml", ec), "XML is a file");
        CHECK(!WebHostFs::IsRegularFile(pack / "riivolution", ec), "directory is not a file");
        CHECK(WebHostFs::Exists(pack / "riivolution", ec) && WebHostFs::Exists(pack / "Binaries" / "Code.pul", ec) &&
                  !WebHostFs::Exists(pack / "nope.bin", ec), "Exists");
        CHECK(WebHostFs::FileSize(pack / "Binaries" / "Code.pul", ec) == 4100 && !ec, "FileSize");
        CHECK(WebHostFs::FileSize(pack / "nope.bin", ec) == static_cast<std::uintmax_t>(-1) && ec, "FileSize of a missing file sets ec");
        CHECK(WebHostFs::WeaklyCanonical(pack / "." / "Race" / ".." / "xml", ec) == pack / "xml" && !ec, "WeaklyCanonical on a mount");
        const auto xmls = WebHostFs::RegularFilesIn(pack / "riivolution", ec);
        CHECK(xmls.size() == 2 && xmls[0] == pack / "riivolution" / "Alt.xml" && xmls[1] == pack / "riivolution" / "notes.txt",
              "RegularFilesIn lists %zu file(s)", xmls.size());
        const auto xmlText = WebHostFs::ReadFile(pack / "xml" / "RetroRewind6.xml");
        CHECK(xmlText && xmlText->find("<wiidisc version=\"1\"") != std::string::npos, "ReadFile on a mount");
        CHECK(!WebHostFs::ReadFile(pack / "nope.xml").has_value(), "ReadFile of a missing mount file");
        size_t visited = 0;
        CHECK(WebHostFs::ForEachMountedFile(pack / "Race", true, [&](const fs::path& path, const std::string& rel, uint64_t) {
                  ++visited;
                  CHECK(path == pack / "Race" / rel, "visited host path %s", path.c_str());
              }) && visited == 3, "ForEachMountedFile visited %zu", visited);
        // Non-mount paths still reach the Emscripten FS.
        CHECK(WebHostFs::IsDirectory("/home/web_user", ec), "MEMFS directory through the shim");
        CHECK(!WebHostFs::ReadFile("/tmp/does/not/exist").has_value(), "missing MEMFS file");

        // --- The real Riivolution path --------------------------------------------------------
        const auto& overlays = RuntimeRiivolution::Overlays();
        CHECK(overlays.size() == 1, "one overlay root (the /app/RetroRewind6 recomp root does not exist), got %zu", overlays.size());
        if (!overlays.empty()) {
            const auto& overlay = overlays[0];
            CHECK(overlay.root == pack, "overlay root %s", overlay.root.c_str());
            CHECK(overlay.patches.has_value(), "pack XML parsed");
            if (overlay.patches) {
                const auto& set = *overlay.patches;
                for (const auto& mapping : set.mappings) {
                    std::printf("mapping kind=%d disc='%s' host='%s' recursive=%d create=%d\n",
                                static_cast<int>(mapping.kind), mapping.discPath.c_str(),
                                mapping.hostPath.c_str(), mapping.recursive, mapping.create);
                }
                CHECK(set.mappings.size() == 4, "4 mappings, got %zu", set.mappings.size());
                CHECK(set.skippedExternals == 1, "one missing external skipped, got %u", set.skippedExternals);
                const auto* menu = FindMapping(set, Kind::File, "/Scene/UI/MenuSingle_E.szs");
                CHECK(menu && menu->hostPath == pack / "Scene/UI/MenuSingle_E.szs" && !menu->create, "file mapping");
                CHECK(menu && ReadsAs(menu->hostPath, "Scene/UI/MenuSingle_E.szs"), "file mapping reads through ReadExact");
                const auto* code = FindMapping(set, Kind::File, "/rr/Code.pul");
                CHECK(code && code->hostPath == pack / "binaries/code.pul" && code->create, "wrong-case file mapping");
                CHECK(code && ReadsAs(code->hostPath, "Binaries/Code.pul"), "wrong-case path reads the real file");
                const auto* course = FindMapping(set, Kind::Folder, "/Race/Course");
                CHECK(course && course->hostPath == pack / "Race/Course" && course->recursive && course->create, "folder mapping");
                if (course) {
                    // What dvd.cpp's ScanDirectory does with a Folder mapping on the web.
                    std::vector<std::string> registered;
                    WebHostFs::ForEachMountedFile(course->hostPath, course->recursive,
                                                  [&](const fs::path& hostPath, const std::string& rel, uint64_t) {
                                                      registered.push_back(course->discPath + "/" + rel);
                                                      CHECK(ReadsAs(hostPath, "Race/Course/" + rel), "folder file %s", rel.c_str());
                                                  });
                    CHECK(registered.size() == 3 && registered[2] == "/Race/Course/sub/old_course.szs",
                          "folder scan registered %zu file(s)", registered.size());
                }
                const auto* byName = FindMapping(set, Kind::FolderByName, "");
                CHECK(byName && byName->hostPath == pack / "ByName", "folder-by-name mapping");
                CHECK(!FindMapping(set, Kind::File, "/extra.bin"), "disabled option contributes nothing");
            }
        }
        const auto& redirect = RuntimeRiivolution::GetSaveRedirect();
        const fs::path expectedSave =
            RuntimeConfigFile::ApplicationDataDirectory() / "riivolution-sd" / "RetroRewind6" / "save" / "RetroWFC";
        CHECK(redirect && redirect->hostDirectory == expectedSave && !redirect->clone,
              "save redirect into the persisted home: %s", redirect ? redirect->hostDirectory.c_str() : "(none)");
        CHECK(expectedSave.generic_string().rfind("/home/web_user/", 0) == 0, "save dir under $HOME: %s", expectedSave.c_str());
    }

    if (g_failures) {
        std::printf("FAIL web riivolution test (%d of %d checks failed)\n", g_failures, g_checks);
        return 1;
    }
    std::printf("PASS web riivolution test (%d checks, %s)\n", g_checks, expectPack ? "pack" : "no pack");
    return 0;
}
