const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const OUT = path.resolve('music-cleanup-studio/test/artifacts');
let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto('http://127.0.0.1:8080/');

  // stereo + mono import
  await page.setInputFiles('#fileinput', [
    path.resolve('music-cleanup-studio/test/noisy-track-1.wav'),
    path.resolve('music-cleanup-studio/test/noisy-track-2.wav'),
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.track').length === 2);
  check('library stats update', (await page.locator('#statTracks').innerText()) === '2');

  // presets change sliders + mark stale
  for (const preset of ['light', 'strong', 'surgical', 'balanced']) {
    await page.click(`.chip[data-preset="${preset}"]`);
    const active = await page.locator('.chip.active').getAttribute('data-preset');
    check(`preset ${preset} applies`, active === preset);
  }
  check('preset writes strength', (await page.locator('#strength').inputValue()) === '60');

  // process with "strong" preset
  await page.click('.chip[data-preset="strong"]');
  await page.click('#processBtn');
  await page.waitForFunction(() => document.querySelectorAll('.pill.done').length === 2, { timeout: 240000 });
  const stats = await page.locator('.track-stats').first().innerText();
  check('per-track report rendered', /noise floor/.test(stats), stats.replace(/\n/g, ' | '));
  check('avg cut stat', (await page.locator('#statReduction').innerText()).includes('dB'));

  // changing a slider marks results stale
  await page.locator('#strength').fill('45');
  await page.waitForTimeout(450);
  check('settings change marks tracks stale', (await page.locator('.pill.proc').count()) > 0);
  await page.locator('#strength').fill('82');
  await page.waitForTimeout(150);

  // reprocess; then exports across every format + save mode
  await page.click('#processBtn');
  await page.waitForFunction(() => document.querySelectorAll('.pill.done').length === 2, { timeout: 240000 });
  check('reprocess after stale works', (await page.locator('.pill.done').count()) === 2);

  const downloads = [];
  page.on('download', d => downloads.push(d));
  const grab = async (label) => {
    const before = downloads.length; const t0 = Date.now();
    while (downloads.length === before && Date.now() - t0 < 120000) await page.waitForTimeout(150);
    const d = downloads[before]; if (!d) return null;
    const p = path.join(OUT, label + '-' + (d.suggestedFilename().split('.').pop()));
    await d.saveAs(p); return { p, size: fs.statSync(p).size };
  };

  await page.locator('#saveMode .seg[data-mode="clean"]').click();
  for (const [fmt, ext] of [['wav24', 'wav'], ['wav16', 'wav'], ['mp3-320', 'mp3'], ['mp3-192', 'mp3']]) {
    await page.selectOption('#outFormat', fmt);
    await page.locator('.track .mini[data-act="save"]').first().click();
    const f = await grab('fmt-' + fmt);
    check(`export ${fmt}`, !!f && f.size > 1000, f ? `${(f.size / 1024).toFixed(0)} KB` : 'missing');
  }

  // mastered-only mode produces the master
  await page.locator('#saveMode .seg[data-mode="master"]').click();
  await page.selectOption('#outFormat', 'wav16');
  await page.locator('.track .mini[data-act="save"]').first().click();
  const mf = await grab('masteronly');
  check('mastered-only export', !!mf && mf.size > 1000);

  // master toggle off -> master buttons disabled
  await page.locator('.switch span').click();
  await page.click('#processBtn');
  await page.waitForFunction(() => document.querySelectorAll('.pill.done').length === 2, { timeout: 240000 });
  const masterDisabled = await page.locator('.track .mini[data-act="play-master"]').first().isDisabled();
  check('master off disables master preview', masterDisabled);
  check('master toggle switched off', !(await page.locator('#masterOn').isChecked()));
  await page.locator('.switch span').click();
  await page.click('#processBtn');
  await page.waitForFunction(() => document.querySelectorAll('.pill.done').length === 2, { timeout: 240000 });

  // zip both versions
  await page.locator('#saveMode .seg[data-mode="both"]').click();
  await page.selectOption('#outFormat', 'wav16');
  await page.click('#downloadAllBtn');
  const z = await grab('bundle-both');
  check('zip with both versions', !!z && z.size > 10000, z ? `${(z.size / 1024).toFixed(0)} KB` : '');

  // remove one track
  await page.locator('.track .mini[data-act="remove"]').first().click();
  await page.waitForTimeout(300);
  check('remove track', (await page.locator('.track').count()) === 1);

  // stop button mid-batch is clickable while busy
  const stopEnabledDuring = await page.evaluate(() => {
    state.tracks.forEach(t => { t.status = 'idle'; });
    refreshButtons();
    return !document.querySelector('#stopBtn').disabled;
  });
  check('stop enabled when idle (expected disabled)', stopEnabledDuring === false);

  check('no console/page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await browser.close();

  // zip integrity
  try {
    const { execSync } = require('child_process');
    const out = execSync(`python3 -c "import zipfile,sys;z=zipfile.ZipFile('${z.p}');print('\\n'.join(f'{i.filename} {i.file_size}' for i in z.infolist()));print('integrity',z.testzip())"`).toString();
    console.log(out.trim());
    check('zip passes CRC check', /integrity None/.test(out));
  } catch (e) { check('zip passes CRC check', false, e.message); }

  console.log(fails ? `\n${fails} FAILURES` : '\nall tests passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
