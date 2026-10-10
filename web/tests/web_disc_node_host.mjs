// Runs one web test module (web_disc_test.mjs, web_riivolution_test.mjs) under Node; needs
// JSPI: Node 24+ with --experimental-wasm-jspi.
// usage: node --experimental-wasm-jspi web_disc_node_host.mjs <module.mjs> <Module options JSON>
//        (the options carry `arguments` and the mkw* settings, see web/js/library_mkw_dvd.js)
import { pathToFileURL } from 'node:url';

const [modulePath, optionsJson] = process.argv.slice(2);
if (typeof WebAssembly.Suspending != 'function') {
  console.error('FAIL: this Node has no JSPI (WebAssembly.Suspending); use Node 24+ with --experimental-wasm-jspi');
  process.exit(2);
}

let finish;
const finished = new Promise((resolve) => (finish = resolve));
const timer = setTimeout(() => finish('FAIL: timed out'), 180_000);
const print = (line) => {
  console.log(line);
  if (/^(PASS|FAIL) web (disc|riivolution) test|^FAIL: /.test(line)) finish(line);
};

const createModule = (await import(pathToFileURL(modulePath).href)).default;
createModule({
  ...JSON.parse(optionsJson),
  print,
  printErr: (line) => console.error(line),
  onAbort: (what) => finish(`FAIL: aborted: ${what}`),
}).catch((error) => finish(`FAIL: ${error && error.stack || error}`));

const result = await finished;
clearTimeout(timer);
if (!result.startsWith('PASS')) console.log(result);
process.exit(result.startsWith('PASS') ? 0 : 1);
