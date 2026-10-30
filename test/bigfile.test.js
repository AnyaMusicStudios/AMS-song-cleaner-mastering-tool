// Realistic long file: does progress actually move, and does the pipeline survive?
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto('http://127.0.0.1:8080/');

  const t0 = Date.now();
  await page.setInputFiles('#fileinput', [path.resolve('music-cleanup-studio/test/long-track.wav')]);
  await page.waitForFunction(() => document.querySelectorAll('.track').length === 1, { timeout: 180000 });
  console.log(`import (decode 3min stereo 48k-forced): ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const meta = await page.locator('.track-meta').innerText();
  console.log('track meta:', meta.replace(/\n/g, ' '));
  check('sample rate reported', /kHz/.test(meta), meta);
  const rateNote = await page.locator('#log').innerText();
  if (/forces/.test(rateNote)) console.log('  (rate warning shown: ' + rateNote.split('\n').find(l => /forces/.test(l)).trim() + ')');

  // sample the progress pill while it is running
  await page.click('#processBtn');
  const samples = [];
  const tStart = Date.now();
  while (Date.now() - tStart < 180000) {
    const pill = await page.locator('.pill.proc').first().innerText().catch(() => null);
    if (pill) samples.push(`${((Date.now() - tStart) / 1000).toFixed(1)}s ${pill.replace(/\n/g, ' ')}`);
    const done = await page.locator('.pill.done').count();
    if (done === 1) break;
    await page.waitForTimeout(700);
  }
  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log('progress samples:\n  ' + samples.filter((_, i) => i % 3 === 0 || i === samples.length - 1).join('\n  '));
  check('processing finished', (await page.locator('.pill.done').count()) === 1, `${elapsed}s`);
  const distinct = new Set(samples.map(s => s.split(' ').slice(1).join(' '))).size;
  check('progress is not stuck at 0%', distinct > 2, `${distinct} distinct progress values`);

  // memory sanity + export of the long file
  const mem = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
  console.log('JS heap after processing:', mem ? mem + ' MB' : 'n/a');

  const dl = [];
  page.on('download', d => dl.push(d));
  await page.locator('#saveMode .seg[data-mode="clean"]').click();
  await page.selectOption('#outFormat', 'mp3-320');
  const before = dl.length; const te = Date.now();
  await page.locator('.track .mini[data-act="save"]').click();
  while (dl.length === before && Date.now() - te < 240000) await page.waitForTimeout(250);
  if (dl[before]) {
    const p = path.resolve('music-cleanup-studio/test/artifacts/long-mp3.mp3');
    await dl[before].saveAs(p);
    const size = fs.statSync(p).size;
    check('MP3 export of 3-min track', size > 1000000, `${(size / 1048576).toFixed(1)} MB in ${((Date.now() - te) / 1000).toFixed(1)}s`);
    check("MP3 duration ≈ 3 min", Math.abs(size * 8 / 320000 - 180) < 5, `${(size * 8 / 320000).toFixed(0)}s at 320k`);
  } else check('MP3 export of 3-min track', false, 'no download');

  // playback of the long clean file
  await page.locator('.ab-btn[data-src="clean"]').click();
  await page.click('#playBtn');
  await page.waitForTimeout(1500);
  check('long file plays', await page.evaluate(() => playing && positionNow() > 0.9));

  check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.screenshot({ path: path.resolve('music-cleanup-studio/test/artifacts/ui-longfile.png') });
  await browser.close();
  console.log(fails ? `\n${fails} FAILURES` : '\nlong-file test passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
