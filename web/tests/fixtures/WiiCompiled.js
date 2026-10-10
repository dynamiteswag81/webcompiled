// TEST STUB standing in for the Emscripten glue (WiiCompiled.js). Lives under web/tests/fixtures
// only; it is never part of web/site or web/dist. It mimics the parts of the classic (non-modularized)
// glue that the frontend relies on: it reads the global `Module` object, uses Module.wasmBinary,
// reports progress through Module.setStatus / monitorRunDependencies, draws to Module.canvas and calls
// Module.onRuntimeInitialized. The page's product selection is recorded in window.__stubProduct.
// The behaviour is selected with ?stub=ok|abort|throw|reject|slow.
(function () {
  var Module = window.Module;
  var mode = new URLSearchParams(location.search).get('stub') || 'ok';
  var canvas = Module.canvas;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // Which glue this is (the test copies this file to RetroRewind.js with __stubGlueName preset) and
  // the product the page selected, so tests can assert on both.
  window.__stubGlue = window.__stubGlueName || 'WiiCompiled.js';
  window.__stubProduct = JSON.stringify(Module.mkwProduct === undefined ? null : Module.mkwProduct);

  console.log('stub glue loaded, mode=' + mode + ', glue=' + window.__stubGlue);
  console.warn('stub warning line');

  function draw() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    var ctx = canvas.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    g.addColorStop(0, '#1b6e3a');
    g.addColorStop(1, '#0c2f5c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = Math.round(24 * dpr) + 'px sans-serif';
    ctx.fillText('stub game canvas (' + mode + ', ' + window.__stubGlue + ')', 24 * dpr, 48 * dpr);
  }

  (async function () {
    Module.setStatus('Downloading data... (0/3)');
    Module.monitorRunDependencies(3);
    for (var i = 2; i >= 0; i--) {
      await sleep(mode === 'slow' ? 700 : 20);
      Module.setStatus('Downloading data... (' + (3 - i) + '/3)');
      Module.monitorRunDependencies(i);
    }
    // The wasm bytes were prefetched by the page; prove they are a real, valid module.
    await WebAssembly.instantiate(Module.wasmBinary, {});
    console.log('stub wasm instantiated (' + Module.wasmBinary.byteLength + ' bytes)');
    Module.setStatus('');
    // ?saves=readonly: what web/js/library_mkw_dvd.js does when another tab owns the save store.
    if (new URLSearchParams(location.search).get('saves') === 'readonly' && Module.onMkwStorageReadOnly) {
      Module.onMkwStorageReadOnly("This game is open in another tab; progress here won't be saved.");
    }
    if (mode === 'slow') await sleep(1500);
    draw();
    Module.onRuntimeInitialized();
    if (mode === 'abort') {
      setTimeout(function () { Module.onAbort('stub abort: unreachable executed'); }, 100);
    } else if (mode === 'throw') {
      setTimeout(function () { throw new Error('stub window error'); }, 100);
    } else if (mode === 'reject') {
      setTimeout(function () { Promise.reject(new Error('stub unhandled rejection')); }, 100);
    }
  })();
})();
