const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:8080/');
  await page.setInputFiles('#fileinput', [
    path.resolve('music-cleanup-studio/test/noisy-track-1.wav'),
    path.resolve('music-cleanup-studio/test/noisy-track-2.wav'),
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.track').length === 2);
  await page.screenshot({ path: 'music-cleanup-studio/test/artifacts/ui-before.png', fullPage: true });
  await page.click('#processBtn');
  await page.waitForFunction(() => document.querySelectorAll('.pill.done').length === 2, { timeout: 120000 });
  await page.locator('.ab-btn[data-src="clean"]').click();
  await page.click('#playBtn');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'music-cleanup-studio/test/artifacts/ui-after.png', fullPage: true });
  // mobile
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await m.goto('http://127.0.0.1:8080/');
  await m.setInputFiles('#fileinput', [path.resolve('music-cleanup-studio/test/noisy-track-2.wav')]);
  await m.waitForFunction(() => document.querySelectorAll('.track').length === 1);
  await m.click('#processBtn');
  await m.waitForFunction(() => document.querySelectorAll('.pill.done').length === 1, { timeout: 120000 });
  await m.screenshot({ path: 'music-cleanup-studio/test/artifacts/ui-mobile.png', fullPage: true });
  await browser.close();
  console.log('shots done');
})();
