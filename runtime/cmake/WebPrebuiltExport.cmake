# Maintainer-only: describe the configured aurora + third-party wasm build so
# web/tools/make_web_prebuilt.py can harvest it into a redistributable package
# (the web counterpart of NativePrebuiltExport.cmake).
#
# Enabled with -DMKW_WEB_PREBUILT_EXPORT_DIR=<dir> on an Emscripten configure. It
# never changes what is compiled: it adds two never-built-by-default probe targets
# and writes a small metadata file. The harvest reads the probe's fully resolved
# compile and link command lines out of build.ninja and subtracts the control's,
# which isolates exactly what aurora::gx/pad/si/vi/mtx + Crypto++ contribute.
#
# The package contains only libraries without game content (aurora, SDL3,
# abseil, zstd, Crypto++, ...). The translated game is never part of it.

if(NOT CMAKE_GENERATOR STREQUAL "Ninja")
    message(FATAL_ERROR "MKW_WEB_PREBUILT_EXPORT_DIR requires the Ninja generator")
endif()
if(NOT MKW_PLATFORM_WEB)
    message(FATAL_ERROR "MKW_WEB_PREBUILT_EXPORT_DIR is for Emscripten (emcmake) configures")
endif()

set(_mkw_wp_probe_dir "${CMAKE_BINARY_DIR}/web_prebuilt_probe")
file(MAKE_DIRECTORY "${_mkw_wp_probe_dir}")
file(WRITE "${_mkw_wp_probe_dir}/probe.cpp"
    "// Links the aurora + third-party closure the web products use; see\n"
    "// runtime/cmake/WebPrebuiltExport.cmake.\n"
    "int main() { return 0; }\n")

add_executable(mkw_wp_probe_control EXCLUDE_FROM_ALL "${_mkw_wp_probe_dir}/probe.cpp")
set_target_properties(mkw_wp_probe_control PROPERTIES UNITY_BUILD OFF)
target_compile_features(mkw_wp_probe_control PRIVATE cxx_std_20)

add_executable(mkw_wp_probe EXCLUDE_FROM_ALL "${_mkw_wp_probe_dir}/probe.cpp")
set_target_properties(mkw_wp_probe PROPERTIES UNITY_BUILD OFF)
target_compile_features(mkw_wp_probe PRIVATE cxx_std_20)
# Exactly the aurora/third-party part of what mkw_runtime_common and the products
# link (PublicProducts.cmake). pugixml and toml11 stay local: one TU / header-only.
target_link_libraries(mkw_wp_probe PRIVATE
    aurora::gx aurora::pad aurora::si aurora::vi aurora::mtx
    mkw::cryptopp)

get_filename_component(_mkw_wp_aurora_dir "${MKW_AURORA_DIR}" ABSOLUTE)
file(WRITE "${MKW_WEB_PREBUILT_EXPORT_DIR}/meta.txt"
    "aurora_dir=${_mkw_wp_aurora_dir}\n"
    "runtime_dir=${CMAKE_CURRENT_SOURCE_DIR}\n"
    "binary_dir=${CMAKE_BINARY_DIR}\n"
    "emscripten_version=${EMSCRIPTEN_VERSION}\n"
    "emscripten_sysroot=${CMAKE_SYSROOT}\n")
message(STATUS "Web prebuilt export: ${MKW_WEB_PREBUILT_EXPORT_DIR}")
