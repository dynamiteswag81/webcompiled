// Host services for the WebAssembly build of WiiCompiled, linked with
// --js-library. Everything here that returns a Promise is a JSPI-suspending
// import (`__async: true`): the calling wasm stack is parked until the promise
// settles, which is how a game that never returns from main() still lets the
// browser render, deliver input and finish network reads.

addToLibrary({
  $MkwHost__deps: ['mkw_host_context_entry'],
  $MkwHost__postset: 'MkwHost.init();',
  $MkwHost: {
    // Suspended host contexts (guest OS threads), keyed by their C handle.
    // A value is the resolver that resumes that context.
    resumers: new Map(),
    yieldQueue: [],
    yieldChannel: null,

    init() {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const queue = MkwHost.yieldQueue;
        MkwHost.yieldQueue = [];
        for (const resume of queue) resume();
      };
      MkwHost.yieldChannel = channel;
      Module['mkwHostContextForget'] = (handle) => MkwHost.resumers.delete(handle);
    },

    // A macrotask boundary without setTimeout's nesting clamp (>= 4 ms once
    // timers nest five deep, which every resumed wasm stack would hit).
    postYield(resume) {
      MkwHost.yieldQueue.push(resume);
      if (MkwHost.yieldQueue.length === 1) MkwHost.yieldChannel.port2.postMessage(0);
    },

    startContext(handle) {
      // Promising export (JSPI_EXPORTS): runs until its first suspension and
      // returns a promise that only settles if the context faults.
      Promise.resolve(_mkw_host_context_entry(handle)).catch((error) => {
        err(`guest host context ${handle} terminated: ${error && error.stack || error}`);
        Module['onMkwFatal']?.(String(error && error.message || error));
        abort(error);
      });
    },
  },

  // Suspends `source` and runs `destination`: resumes it if it is parked, or
  // starts it once `source` has actually suspended (a microtask later) so the
  // two stacks never nest.
  mkw_host_context_switch__deps: ['$MkwHost'],
  mkw_host_context_switch__async: true,
  mkw_host_context_switch: (source, destination) => new Promise((resolve) => {
    MkwHost.resumers.set(source, resolve);
    const resume = MkwHost.resumers.get(destination);
    if (resume) {
      MkwHost.resumers.delete(destination);
      resume();
    } else {
      queueMicrotask(() => MkwHost.startContext(destination));
    }
  }),

  // Gives the browser a turn. ms <= 0 is a bare macrotask hop (input, canvas
  // presentation and network callbacks all get to run); ms >= 1 sleeps on a
  // timer so an idle game does not spin a core. The timer is armed from a hop:
  // a timer armed from a timer's continuation nests, and nested timers are
  // clamped to >= 4 ms, which would make every 1 ms scheduler slice 4 ms.
  mkw_host_yield__deps: ['$MkwHost'],
  mkw_host_yield__async: true,
  mkw_host_yield: (ms) => new Promise((resolve) => {
    if (ms >= 1) MkwHost.postYield(() => setTimeout(resolve, ms));
    else MkwHost.postYield(resolve);
  }),

  // Page visibility. The runtime parks the whole guest (WebHost::WaitWhilePageHidden) while the
  // page is hidden: a background tab otherwise keeps simulating with no frames to show, burns a
  // core and overflows the audio queue. Module.mkwPaused / mkwParkCount expose the state.
  mkw_host_page_hidden: () =>
    (typeof document !== 'undefined' && document.visibilityState === 'hidden') ? 1 : 0,

  mkw_host_wait_visible__async: true,
  mkw_host_wait_visible: () => new Promise((resolve) => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      resolve();
      return;
    }
    Module['mkwPaused'] = true;
    Module['mkwParkCount'] = (Module['mkwParkCount'] || 0) + 1;
    const onChange = () => {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', onChange);
      Module['mkwPaused'] = false;
      resolve();
    };
    document.addEventListener('visibilitychange', onChange);
  }),

  // One call per presented frame (Module.mkwFramesPresented).
  mkw_host_note_frame: () => {
    Module['mkwFramesPresented'] = (Module['mkwFramesPresented'] || 0) + 1;
  },

  // The runtime's fatal report (ShowRuntimeFatalPopup), for the page's error overlay. Not a
  // suspending import: the runtime continues into its own exit path right after.
  mkw_host_report_fatal__deps: ['$UTF8ToString'],
  mkw_host_report_fatal: (message) => {
    const text = UTF8ToString(message);
    if (Module['onMkwFatal']) Module['onMkwFatal'](text);
    else err(text);
  },
});
