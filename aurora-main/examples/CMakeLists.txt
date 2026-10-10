if (AURORA_ENABLE_GX)
  add_executable(simple simple.c)
  target_link_libraries(simple PRIVATE aurora::core aurora::gx aurora::main aurora::vi)
  # Viewport depth ranges outside [0, 1]: draws and reads back depths (see depth_range.c).
  add_executable(depth_range depth_range.c)
  target_link_libraries(depth_range PRIVATE aurora::core aurora::gx aurora::main aurora::vi)
  if (EMSCRIPTEN)
    # A page with Emscripten's default shell (it provides <canvas id="canvas">). JSPI lets the
    # frame loop and WebGPU waits suspend into the browser event loop.
    foreach (example simple depth_range)
      set_target_properties(${example} PROPERTIES SUFFIX ".html")
      target_link_options(${example} PRIVATE -sJSPI -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1)
    endforeach ()
  endif ()
endif ()
