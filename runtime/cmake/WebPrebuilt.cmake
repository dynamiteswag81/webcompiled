# Web (Emscripten) counterpart of NativePrebuilt.cmake: consume a precompiled
# package of the libraries that contain no game content (aurora, SDL3, abseil,
# zstd, libpng, freetype, imgui, Crypto++, ...) instead of compiling them, so a
# host only compiles the runtime and the translated game. The package is made by
# web/tools/make_web_prebuilt.py and ships in web/prebuilt/. It never contains
# translated game code.
#
# Two entry points, both include()d from runtime/CMakeLists.txt:
#   * mkw_web_prebuilt_check(): early, decides MKW_USE_WEB_PREBUILT. A package
#     whose source fingerprint differs from this checkout (aurora-main, the
#     vendored Crypto++, runtime/CMakeLists.txt, the Emscripten version) is not
#     used: the build falls back to compiling from source with a warning, since a
#     slower build is better than a subtly mismatched one.
#   * mkw_web_prebuilt_import(): in place of add_subdirectory(aurora-main),
#     defines aurora::gx/pad/si/vi/mtx and mkw::cryptopp from the package.

get_filename_component(_mkw_wp_runtime_dir "${CMAKE_CURRENT_LIST_DIR}" DIRECTORY)
get_filename_component(_mkw_wp_aurora_dir "${_mkw_wp_runtime_dir}/../aurora-main" ABSOLUTE)

# Must stay byte-for-byte in step with source_fingerprint() in
# web/tools/make_web_prebuilt.py. Text sources only, CRLF folded to LF, so a
# Windows checkout with autocrlf produces the same value as the package build.
function(mkw_web_prebuilt_fingerprint out_var emscripten_version)
    set(_lines "")
    set(_roots "aurora-main|${_mkw_wp_aurora_dir}"
               "cryptopp|${_mkw_wp_runtime_dir}/third_party/cryptopp")
    foreach(_root IN LISTS _roots)
        string(REPLACE "|" ";" _pair "${_root}")
        list(GET _pair 0 _label)
        list(GET _pair 1 _dir)
        file(GLOB_RECURSE _files RELATIVE "${_dir}"
            "${_dir}/*.c" "${_dir}/*.cpp" "${_dir}/*.h" "${_dir}/*.hpp" "${_dir}/*.cmake"
            "${_dir}/*.txt" "${_dir}/*.mm" "${_dir}/*.inc" "${_dir}/*.asm" "${_dir}/*.S")
        list(FILTER _files EXCLUDE REGEX "^build[^/]*/")
        list(SORT _files)
        foreach(_file IN LISTS _files)
            file(READ "${_dir}/${_file}" _content)
            string(REPLACE "\r\n" "\n" _content "${_content}")
            string(SHA256 _hash "${_content}")
            string(APPEND _lines "${_label}/${_file} ${_hash}\n")
        endforeach()
    endforeach()
    file(READ "${_mkw_wp_runtime_dir}/CMakeLists.txt" _content)
    string(REPLACE "\r\n" "\n" _content "${_content}")
    string(SHA256 _hash "${_content}")
    string(APPEND _lines "runtime/CMakeLists.txt ${_hash}\n")
    string(APPEND _lines "emscripten ${emscripten_version}\n")
    string(SHA256 _fingerprint "${_lines}")
    set(${out_var} "${_fingerprint}" PARENT_SCOPE)
endfunction()

function(mkw_web_prebuilt_check)
    set(MKW_USE_WEB_PREBUILT FALSE PARENT_SCOPE)
    get_filename_component(_pkg "${MKW_WEB_PREBUILT_DIR}" ABSOLUTE)
    if(NOT EXISTS "${_pkg}/web_prebuilt.cmake")
        message(WARNING "MKW_WEB_PREBUILT_DIR has no web_prebuilt.cmake (${_pkg}); "
            "compiling aurora and its libraries from source instead")
        return()
    endif()
    include("${_pkg}/web_prebuilt.cmake")
    mkw_web_prebuilt_fingerprint(_current "${EMSCRIPTEN_VERSION}")
    if(NOT _current STREQUAL MKW_WP_SOURCE_FINGERPRINT)
        message(WARNING "The prebuilt web libraries in ${_pkg} were built from different sources "
            "or another Emscripten version (package ${MKW_WP_EMSCRIPTEN_VERSION}, "
            "here ${EMSCRIPTEN_VERSION}); compiling them from source instead. "
            "Regenerate the package with web/tools/make_web_prebuilt.py.")
        return()
    endif()
    set(MKW_USE_WEB_PREBUILT TRUE PARENT_SCOPE)
    set(MKW_WEB_PREBUILT_PACKAGE_DIR "${_pkg}" PARENT_SCOPE)
endfunction()

function(mkw_web_prebuilt_resolve out_var)
    set(_resolved "")
    foreach(_item IN LISTS ARGN)
        string(REPLACE "@PKG@" "${MKW_WEB_PREBUILT_PACKAGE_DIR}" _item "${_item}")
        string(REPLACE "@AURORA@" "${_mkw_wp_aurora_dir}" _item "${_item}")
        string(REPLACE "@RUNTIME@" "${_mkw_wp_runtime_dir}" _item "${_item}")
        list(APPEND _resolved "${_item}")
    endforeach()
    set(${out_var} "${_resolved}" PARENT_SCOPE)
endfunction()

macro(mkw_web_prebuilt_import)
    include("${MKW_WEB_PREBUILT_PACKAGE_DIR}/web_prebuilt.cmake")
    mkw_web_prebuilt_resolve(_mkw_wp_includes ${MKW_WP_INCLUDE_DIRECTORIES})
    mkw_web_prebuilt_resolve(_mkw_wp_links ${MKW_WP_LINK_LIBRARIES})
    foreach(_dir IN LISTS _mkw_wp_includes)
        if(NOT IS_DIRECTORY "${_dir}")
            message(FATAL_ERROR "The prebuilt web package expects a missing include directory: ${_dir}")
        endif()
    endforeach()
    foreach(_item IN LISTS _mkw_wp_links)
        if(IS_ABSOLUTE "${_item}" AND NOT EXISTS "${_item}")
            message(FATAL_ERROR "The prebuilt web package is missing an archive: ${_item}")
        endif()
    endforeach()

    # One interface target carries the whole surface; the public aurora names are
    # thin aliases of it (as in NativePrebuilt.cmake).
    add_library(mkw_web_prebuilt INTERFACE IMPORTED GLOBAL)
    set_target_properties(mkw_web_prebuilt PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${_mkw_wp_includes}"
        INTERFACE_COMPILE_DEFINITIONS "${MKW_WP_COMPILE_DEFINITIONS}"
        INTERFACE_COMPILE_OPTIONS "${MKW_WP_COMPILE_OPTIONS}"
        INTERFACE_LINK_LIBRARIES "${_mkw_wp_links}"
        INTERFACE_LINK_OPTIONS "${MKW_WP_LINK_OPTIONS}")
    foreach(_target gx pad si vi mtx)
        add_library(aurora::${_target} INTERFACE IMPORTED GLOBAL)
        set_target_properties(aurora::${_target} PROPERTIES INTERFACE_LINK_LIBRARIES mkw_web_prebuilt)
    endforeach()

    add_library(mkw_cryptopp STATIC IMPORTED GLOBAL)
    set_target_properties(mkw_cryptopp PROPERTIES
        IMPORTED_LOCATION "${MKW_WEB_PREBUILT_PACKAGE_DIR}/lib/libmkw_cryptopp.a"
        INTERFACE_INCLUDE_DIRECTORIES "${_mkw_wp_runtime_dir}/third_party"
        INTERFACE_COMPILE_DEFINITIONS "${MKW_CRYPTOPP_INTERFACE_DEFINITIONS}")
    add_library(mkw::cryptopp ALIAS mkw_cryptopp)

    list(LENGTH _mkw_wp_links _mkw_wp_link_count)
    message(STATUS "aurora and its libraries come from the prebuilt web package "
        "(${_mkw_wp_link_count} link inputs, Emscripten ${MKW_WP_EMSCRIPTEN_VERSION}); "
        "only the runtime and the game are compiled here")
endmacro()
