if (AURORA_ENABLE_GX)
  add_executable(simple simple.c)
  target_link_libraries(simple PRIVATE aurora::core aurora::gx aurora::main aurora::vi)
  if (EMSCRIPTEN)
    # A page with Emscripten's default shell (it provides <canvas id="canvas">). JSPI lets the
    # frame loop and WebGPU waits suspend into the browser event loop.
    set_target_properties(simple PROPERTIES SUFFIX ".html")
    target_link_options(simple PRIVATE -sJSPI -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1)
  endif ()
endif ()
