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

  // Gives the browser a turn. ms <= 1 is a bare macrotask hop (input, canvas
  // presentation and network callbacks all get to run); longer waits use a
  // timer so an idle game does not spin a core.
  mkw_host_yield__deps: ['$MkwHost'],
  mkw_host_yield__async: true,
  mkw_host_yield: (ms) => new Promise((resolve) => {
    if (ms > 1) setTimeout(resolve, ms);
    else MkwHost.postYield(resolve);
  }),
});
