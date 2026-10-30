// Boot smoke test: catches "function deleted by a refactor" and dead-handler bugs,
// which otherwise only show up when a user clicks the button.
const { chromium } = require('playwright');
const path = require('path');
let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); if (!c) fails++; };

const REQUIRED = [
  'processAll', 'processTrack', 'readSettings', 'readMasterSettings', 'renderTracks', 'refreshButtons',
  'selectTrack', 'setSource', 'bufferFor', 'playBuffer', 'stopPlayback', 'positionNow', 'drawWave',
  'encode', 'saveTrack', 'saveAll', 'download', 'job', 'ensureWorker', 'addFiles', 'log',
  'peekSampleRate', 'decodeAtOriginalRate', 'newCollector', 'invalidateResults', 'versionFor',
];

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('http://127.0.0.1:8080/');
  await page.waitForTimeout(400);

  check('app boots without errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  check('boot flag set', await page.evaluate(() => window.__APP_READY__ === true));

  const missing = await page.evaluate((names) => names.filter((n) => typeof window[n] !== 'function' && typeof eval('typeof ' + n) !== 'function'), REQUIRED.filter(n => n !== 'versionFor'));
  check('all UI functions exist', missing.length === 0, missing.join(', '));

  // click every interactive control on an empty library; nothing may throw
  const ids = await page.evaluate(() => Array.from(document.querySelectorAll('button, .chip, .seg, .ab-btn, details > summary'))
    .map((el, i) => { el.dataset.probe = i; return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '.' + (el.className || '').split(' ').join('.')); }));
  for (const sel of ['#processBtn', '#stopBtn', '#clearBtn', '#downloadAllBtn', '.chip[data-preset="light"]', '.chip[data-preset="surgical"]',
                     '.seg[data-mode="clean"]', '.seg[data-mode="master"]', '.seg[data-mode="both"]', '.ab-btn[data-src="orig"]',
                     '.ab-btn[data-src="master"]', '#playBtn', 'details.advanced > summary', '#browseBtn']) {
    const el = page.locator(sel).first();
    if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(60); }
  }
  check('clicking every control on an empty library is safe', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.locator('.switch span').click();
  await page.locator('#masterOn').waitFor({ state: 'attached' });
  check('master switch toggles', (await page.locator('#masterOn').isChecked()) === false);
  await page.locator('.switch span').click();

  // keyboard shortcuts on an empty library
  for (const key of ['Space', 'a', 'A', 'Escape', 'Enter']) await page.keyboard.press(key);
  check('keyboard shortcuts are safe with no track', errs.length === 0, errs.slice(0, 3).join(' | '));

  // now a real track, and the save path with nothing processed yet
  await page.setInputFiles('#fileinput', [path.resolve('music-cleanup-studio/test/noisy-track-2.wav')]);
  await page.waitForFunction(() => document.querySelectorAll('.track').length === 1);
  const saveDisabled = await page.locator('.track .mini[data-act="save"]').isDisabled();
  check('Save disabled before processing', saveDisabled);
  await page.locator('.track .mini[data-act="play-orig"]').click();
  await page.waitForTimeout(400);
  check('original preview plays before processing', await page.evaluate(() => playing));
  check('no errors so far', errs.length === 0, errs.slice(0, 3).join(' | '));

  await browser.close();
  console.log(fails ? `\n${fails} FAILURES` : '\nsmoke test passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
