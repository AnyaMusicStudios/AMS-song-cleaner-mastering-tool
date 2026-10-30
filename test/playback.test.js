const { chromium } = require('playwright');
const path = require('path');
let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
};
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', e => { console.log('PAGEERROR', e.message); fails++; });
  await page.goto('http://127.0.0.1:8080/');
  await page.setInputFiles('#fileinput', [path.resolve('music-cleanup-studio/test/noisy-track-2.wav')]);
  await page.waitForFunction(() => document.querySelectorAll('.track').length === 1);
  await page.click('#processBtn');
  await page.waitForFunction(() => document.querySelectorAll('.pill.done').length === 1, { timeout: 120000 });

  await page.locator('.ab-btn[data-src="clean"]').click();
  check('A/B click does not start playback', !(await page.evaluate(() => playing)));

  await page.click('#playBtn');
  await page.waitForTimeout(1000);
  const p1 = await page.evaluate(() => positionNow());
  check('playback advances', p1 > 0.8 && p1 < 1.6, `pos=${p1.toFixed(2)}`);
  check('playhead moves', (await page.locator('#playhead').evaluate(e => parseFloat(e.style.left))) > 3);

  // pause + resume keeps position
  await page.click('#playBtn');
  await page.waitForTimeout(250);
  const pausedPos = await page.evaluate(() => positionNow());
  check('pause keeps position', pausedPos > 0.5, `pos=${pausedPos.toFixed(2)}`);
  await page.click('#playBtn');
  await page.waitForTimeout(700);
  const resumed = await page.evaluate(() => positionNow());
  check('resume continues from pause point', resumed >= pausedPos + 0.4, `${pausedPos.toFixed(2)} -> ${resumed.toFixed(2)}`);

  // seek to 50% then play
  const box = await page.locator('.tp-wave').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.waitForTimeout(200);
  const seekPos = await page.evaluate(() => positionNow());
  check('seek sets position ~50%', Math.abs(seekPos - 4.5) < 0.5, `pos=${seekPos.toFixed(2)}`);
  check('seek while playing keeps playing', await page.evaluate(() => playing));
  const afterSeek = await page.evaluate(() => positionNow());
  check('seek resumes near seek point', Math.abs(afterSeek - seekPos) < 0.6, `${seekPos.toFixed(2)} -> ${afterSeek.toFixed(2)}`);

  // A/B during playback keeps playing at same position
  const beforeAB = await page.evaluate(() => positionNow());
  await page.locator('.ab-btn[data-src="orig"]').click();
  await page.waitForTimeout(400);
  const afterAB = await page.evaluate(() => positionNow());
  check('A/B during playback keeps playing', await page.evaluate(() => playing));
  check('A/B keeps position', Math.abs(afterAB - beforeAB) < 0.8, `${beforeAB.toFixed(2)} -> ${afterAB.toFixed(2)}`);
  check('A/B switched source', (await page.locator('.ab-btn.active').getAttribute('data-src')) === 'orig');

  // A/B while paused stays paused
  await page.click('#playBtn');
  await page.waitForTimeout(200);
  await page.locator('.ab-btn[data-src="master"]').click();
  await page.waitForTimeout(200);
  check('A/B while paused stays paused', !(await page.evaluate(() => playing)));

  // space bar toggles
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  check('space starts playback', await page.evaluate(() => playing));
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  check('space pauses playback', !(await page.evaluate(() => playing)));

  // track buttons in list
  await page.locator('.track .mini[data-act="play-noise"]').first().click();
  await page.waitForTimeout(400);
  check('Noise preview button plays', await page.evaluate(() => playing && state.source === 'noise'));
  await page.locator('.track .mini[data-act="play-clean"]').first().click();
  await page.waitForTimeout(300);
  check('Clean preview button plays', await page.evaluate(() => playing && state.source === 'clean'));

  // volume
  await page.locator('#volume').fill('0.3');
  check('volume reaches gain node', Math.abs(await page.evaluate(() => gainNode.gain.value) - 0.3) < 0.01);

  // stop / clear resets
  await page.click('#stopBtn').catch(() => {});
  await page.click('#clearBtn');
  await page.waitForTimeout(300);
  check('clear empties library', (await page.locator('.track').count()) === 0);
  check('clear stops playback', !(await page.evaluate(() => playing)));

  await page.screenshot({ path: path.resolve('music-cleanup-studio/test/artifacts/ui-transport.png') });
  await browser.close();
  console.log(fails ? `\n${fails} FAILURES` : '\nall transport checks passed');
  process.exit(fails ? 1 : 0);
})();
