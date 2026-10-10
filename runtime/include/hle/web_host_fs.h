// Host-filesystem shim for code that walks user-supplied trees (Riivolution packs, overlay
// roots): on the web, paths under a WebDisc mount (/disc, /mods/<name>) are answered from the
// streamed manifests; every other path, and every path in native builds, goes straight to the
// std::filesystem / std::ifstream call the code made before this shim existed.
#pragma once

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <system_error>
#include <vector>

#ifdef __EMSCRIPTEN__
#include "hle/web_disc.h"
#endif

namespace WebHostFs {

inline bool IsDirectory(const std::filesystem::path& path, std::error_code& ec) {
#ifdef __EMSCRIPTEN__
    if (const auto location = WebDisc::Locate(path)) {
        ec.clear();
        return WebDisc::IsDirectory(location->mount, location->relPath);
    }
#endif
    return std::filesystem::is_directory(path, ec);
}

inline bool IsRegularFile(const std::filesystem::path& path, std::error_code& ec) {
#ifdef __EMSCRIPTEN__
    if (const auto location = WebDisc::Locate(path)) {
        ec.clear();
        return WebDisc::FileSize(location->mount, location->relPath).has_value();
    }
#endif
    return std::filesystem::is_regular_file(path, ec);
}

inline bool Exists(const std::filesystem::path& path, std::error_code& ec) {
#ifdef __EMSCRIPTEN__
    if (const auto location = WebDisc::Locate(path)) {
        ec.clear();
        return WebDisc::FileSize(location->mount, location->relPath).has_value() ||
               WebDisc::IsDirectory(location->mount, location->relPath);
    }
#endif
    return std::filesystem::exists(path, ec);
}

// Like std::filesystem::file_size(path, ec): static_cast<uintmax_t>(-1) and ec set on failure.
inline std::uintmax_t FileSize(const std::filesystem::path& path, std::error_code& ec) {
#ifdef __EMSCRIPTEN__
    if (const auto location = WebDisc::Locate(path)) {
        if (const auto size = WebDisc::FileSize(location->mount, location->relPath)) {
            ec.clear();
            return static_cast<std::uintmax_t>(*size);
        }
        ec = std::make_error_code(std::errc::no_such_file_or_directory);
        return static_cast<std::uintmax_t>(-1);
    }
#endif
    return std::filesystem::file_size(path, ec);
}

// Mount paths are virtual (nothing to resolve symlinks against): they normalize lexically.
inline std::filesystem::path WeaklyCanonical(const std::filesystem::path& path, std::error_code& ec) {
#ifdef __EMSCRIPTEN__
    if (WebDisc::Locate(path)) {
        ec.clear();
        return path.lexically_normal();
    }
#endif
    return std::filesystem::weakly_canonical(path, ec);
}

// The regular files directly inside `directory`, in iteration order (manifest order for mounts).
// Natively this is exactly the directory_iterator loop the callers used to inline, including
// its shared-error_code stop condition.
inline std::vector<std::filesystem::path> RegularFilesIn(const std::filesystem::path& directory,
                                                         std::error_code& ec) {
    std::vector<std::filesystem::path> files;
#ifdef __EMSCRIPTEN__
    if (const auto location = WebDisc::Locate(directory)) {
        ec.clear();
        WebDisc::ForEachFile(location->mount, location->relPath, /*recursive=*/false,
                             [&](const std::string& relativeToDir, const std::string&, uint64_t) {
                                 files.push_back(directory / relativeToDir);
                             });
        return files;
    }
#endif
    for (const auto& entry : std::filesystem::directory_iterator(directory, ec)) {
        if (ec) {
            break;
        }
        if (entry.is_regular_file(ec)) {
            files.push_back(entry.path());
        }
    }
    return files;
}

// Whole file as bytes-in-a-string, or nullopt when it cannot be opened (or read, for mounts).
inline std::optional<std::string> ReadFile(const std::filesystem::path& path) {
#ifdef __EMSCRIPTEN__
    if (const auto location = WebDisc::Locate(path)) {
        std::vector<uint8_t> bytes;
        if (!WebDisc::ReadWhole(location->mount, location->relPath, bytes)) {
            return std::nullopt;
        }
        return std::string(bytes.begin(), bytes.end());
    }
#endif
    std::ifstream stream(path, std::ios::binary);
    if (!stream.is_open()) {
        return std::nullopt;
    }
    std::ostringstream buffer;
    buffer << stream.rdbuf();
    return buffer.str();
}

#ifdef __EMSCRIPTEN__
// Web only: visits the regular files under a mounted directory with their host paths
// (`directory / relativeToDir`) and sizes. Returns false when `directory` is not under a
// mount, so the caller falls back to its std::filesystem walk.
template <typename Visit>
bool ForEachMountedFile(const std::filesystem::path& directory, bool recursive, Visit&& visit) {
    const auto location = WebDisc::Locate(directory);
    if (!location) {
        return false;
    }
    WebDisc::ForEachFile(location->mount, location->relPath, recursive,
                         [&](const std::string& relativeToDir, const std::string&, uint64_t size) {
                             visit(directory / relativeToDir, relativeToDir, size);
                         });
    return true;
}
#endif

} // namespace WebHostFs
