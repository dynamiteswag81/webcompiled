// Runs the web disc test module under Node (needs JSPI: Node 24+ with --experimental-wasm-jspi).
// usage: node --experimental-wasm-jspi web_disc_node_host.mjs <web_disc_test.mjs> <manifest URL> <argv JSON>
import { pathToFileURL } from 'node:url';

const [modulePath, manifestUrl, argvJson] = process.argv.slice(2);
if (typeof WebAssembly.Suspending != 'function') {
  console.error('FAIL: this Node has no JSPI (WebAssembly.Suspending); use Node 24+ with --experimental-wasm-jspi');
  process.exit(2);
}

let finish;
const finished = new Promise((resolve) => (finish = resolve));
const timer = setTimeout(() => finish('FAIL: timed out'), 180_000);
const print = (line) => {
  console.log(line);
  if (/^(PASS|FAIL) web disc test|^FAIL: /.test(line)) finish(line);
};

const createModule = (await import(pathToFileURL(modulePath).href)).default;
createModule({
  arguments: JSON.parse(argvJson),
  mkwDiscManifestUrl: manifestUrl,
  print,
  printErr: (line) => console.error(line),
  onAbort: (what) => finish(`FAIL: aborted: ${what}`),
}).catch((error) => finish(`FAIL: ${error && error.stack || error}`));

const result = await finished;
clearTimeout(timer);
if (!result.startsWith('PASS')) console.log(result);
process.exit(result.startsWith('PASS') ? 0 : 1);
