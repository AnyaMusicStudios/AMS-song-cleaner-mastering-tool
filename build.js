/* build.js — bundle the app into one self-contained HTML file.
   Usage: node build.js   ->  standalone/music-cleanup-studio.html            */
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('index.html');
const css = read('styles.css');
const zipSrc = read('zip.js');
const appSrc = read('app.js');
const dspSrc = read('src/dsp.js');
const lameSrc = read('vendor/lame.min.js');

// worker = DSP + MP3 encoder + worker body, with importScripts stripped
let workerSrc = read('src/cleanup.worker.js')
  .replace(/^importScripts\(.*$/gm, '')
  .replace(/let lameReady = false;[\s\S]*?}\n/, 'const lameReady = true;\n');
workerSrc = `/* --- dsp.js (inlined) --- */\n${dspSrc}\n/* --- lame.min.js (inlined) --- */\n${lameSrc}\n/* --- worker --- */\n${workerSrc}`;

if (/<\/script/i.test(workerSrc)) throw new Error('worker source contains a closing script tag');

// inline css
// NOTE: replacement functions are used everywhere so that `$$`, `$&` etc. in the
// sources are not interpreted as String.replace patterns.
html = html.replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${css}\n</style>`);

// worker from blob
const workerBoot = `
<script type="text/plain" id="worker-src">
${workerSrc}
</script>`;

// replace the two script tags at the bottom with inlined code
const appBundled = appSrc.replace(
  "worker = new Worker('src/cleanup.worker.js');",
  () => "const src = document.getElementById('worker-src').textContent;\n    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));"
);

html = html.replace('<script src="zip.js"></script>', () => '');
html = html.replace('<script src="app.js"></script>',
  () => `${workerBoot}\n<script>\n${zipSrc}\n</script>\n<script>\n${appBundled}\n</script>`);

fs.mkdirSync(path.join(root, 'standalone'), { recursive: true });
const out = path.join(root, 'standalone', 'music-cleanup-studio.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} — ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
