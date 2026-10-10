// Checks that the page's copy of the keyboard layout (web/site/main.js KEYBOARD_LAYOUT) is the
// C++ table (runtime/include/web_input_layout.h, printed by `pad_merge_test --layout-json`).
//
//   node web/tests/input/check_layout_sync.mjs LAYOUT_JSON_FILE
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainJs = fs.readFileSync(path.resolve(here, '../../site/main.js'), 'utf8');
const m = /\/\*BEGIN_KEYBOARD_LAYOUT\*\/([\s\S]*?)\/\*END_KEYBOARD_LAYOUT\*\//.exec(mainJs);
if (!m) {
  console.log('FAIL web/site/main.js has no /*BEGIN_KEYBOARD_LAYOUT*/ ... /*END_KEYBOARD_LAYOUT*/ block');
  process.exit(1);
}
const page = JSON.parse(m[1]);
const cpp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let failures = 0;
const fields = ['control', 'code', 'key', 'sdlName', 'action'];
if (page.length !== cpp.length) {
  console.log(`FAIL main.js has ${page.length} entries, web_input_layout.h ${cpp.length}`);
  failures++;
}
for (let i = 0; i < Math.max(page.length, cpp.length); i++) {
  const a = page[i] || {};
  const b = cpp[i] || {};
  const diff = fields.filter((f) => a[f] !== b[f]);
  if (diff.length) {
    console.log(`FAIL entry ${i}: main.js ${JSON.stringify(a)} vs C++ ${JSON.stringify(b)}`);
    failures++;
  }
}
console.log(failures ? `FAIL keyboard layout copies differ (${failures})` : `PASS main.js KEYBOARD_LAYOUT matches web_input_layout.h (${cpp.length} entries)`);
process.exit(failures ? 1 : 0);
