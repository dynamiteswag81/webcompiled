# Browser input test harness: aurora + the runtime's web input glue, linked as WiiCompiled.js/.wasm
# so the real page (web/site) can host it. No game data. Driven by run_input_test.sh.
#
#   emcmake cmake -S web/tests/input -B <dir> -G Ninja -DCMAKE_BUILD_TYPE=Release [FETCHCONTENT_*]
#   ninja -C <dir> WiiCompiled
cmake_minimum_required(VERSION 3.25)
project(mkw_web_input_test C CXX)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Configure with emcmake (Emscripten); the native unit test is pad_merge_test.cpp")
endif()

get_filename_component(MKW_REPO "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)

# Same rules as the product (runtime/CMakeLists.txt): native wasm exceptions and longjmp
# everywhere, so JSPI never finds a JS trampoline between main and a suspend point.
add_compile_options(-fwasm-exceptions -sSUPPORT_LONGJMP=wasm)
add_link_options(-fwasm-exceptions -sSUPPORT_LONGJMP=wasm)

set(SDL_SHARED OFF CACHE BOOL "" FORCE)
set(SDL_STATIC ON CACHE BOOL "" FORCE)
set(SDL_TEST OFF CACHE BOOL "" FORCE)
set(CMAKE_DISABLE_PRECOMPILE_HEADERS ON)
add_subdirectory("${MKW_REPO}/aurora-main" aurora-build EXCLUDE_FROM_ALL)
set(CMAKE_DISABLE_PRECOMPILE_HEADERS OFF)
foreach(t aurora_core aurora_gx aurora_pad aurora_si aurora_mtx aurora_vi)
    if(TARGET ${t})
        target_compile_options(${t} PRIVATE -O2 -w)
    endif()
endforeach()

add_executable(WiiCompiled
    input_harness.cpp
    "${MKW_REPO}/runtime/src/platform/web/web_input.cpp")
target_include_directories(WiiCompiled PRIVATE "${MKW_REPO}/runtime/include")
target_compile_features(WiiCompiled PRIVATE cxx_std_20)
target_compile_definitions(WiiCompiled PRIVATE TARGET_PC SDL_MAIN_HANDLED)
target_link_libraries(WiiCompiled PRIVATE aurora::core aurora::gx aurora::pad aurora::si aurora::vi)
set_target_properties(WiiCompiled PROPERTIES SUFFIX ".js")
target_link_options(WiiCompiled PRIVATE
    -sJSPI
    -sENVIRONMENT=web
    -sALLOW_MEMORY_GROWTH=1
    -sSTACK_SIZE=1MB
    -sEXPORTED_RUNTIME_METHODS=FS,ENV
    -lidbfs.js
    "--js-library=${MKW_REPO}/web/js/library_mkw_input.js"
    "--js-library=${MKW_REPO}/web/js/library_mkw_dvd.js")
set_property(TARGET WiiCompiled APPEND PROPERTY LINK_DEPENDS
    "${MKW_REPO}/web/js/library_mkw_input.js" "${MKW_REPO}/web/js/library_mkw_dvd.js")
