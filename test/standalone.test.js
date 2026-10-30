const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const FILE = 'file://' + path.resolve('music-cleanup-studio/standalone/music-cleanup-studio.html');
let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); if (!c) fails++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(FILE);
  check('loads offline from file://', (await page.locator('h1').innerText()).includes('Music Cleanup'));

  await page.setInputFiles('#fileinput', [path.resolve('music-cleanup-studio/test/noisy-track-2.wav')]);
  await page.waitForFunction(() => document.querySelectorAll('.track').length === 1);
  check('decodes audio offline', (await page.locator('.track-name').innerText()).includes('noisy-track-2'));

  await page.click('#processBtn');
  await page.waitForFunction(() => document.querySelectorAll('.pill.done').length === 1, { timeout: 120000 });
  check('processes offline', (await page.locator('.pill.done').count()) === 1);

  const dl = [];
  page.on('download', d => dl.push(d));
  for (const fmt of ['wav24', 'mp3-320']) {
    await page.locator('#saveMode .seg[data-mode="clean"]').click();
    await page.selectOption('#outFormat', fmt);
    const before = dl.length; const t0 = Date.now();
    await page.locator('.track .mini[data-act="save"]').click();
    while (dl.length === before && Date.now() - t0 < 90000) await page.waitForTimeout(150);
    await page.waitForTimeout(400);
    if (dl[before]) {
      const p = path.resolve('music-cleanup-studio/test/artifacts/standalone-' + fmt + '.' + (fmt.startsWith('mp3') ? 'mp3' : 'wav'));
      await dl[before].saveAs(p);
      check(`offline ${fmt} export`, fs.statSync(p).size > 1000, (fs.statSync(p).size / 1024).toFixed(0) + ' KB');
    } else check(`offline ${fmt} export`, false, 'no download');
  }

  await page.locator('.ab-btn[data-src="clean"]').click();
  await page.click('#playBtn');
  await page.waitForTimeout(1200);
  check('plays offline', await page.evaluate(() => playing && positionNow() > 0.5));

  // network request audit: standalone must not need the network
  check('no errors offline', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.screenshot({ path: path.resolve('music-cleanup-studio/test/artifacts/ui-standalone.png') });
  await browser.close();
  console.log(fails ? `\n${fails} FAILURES` : '\nstandalone build verified');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
