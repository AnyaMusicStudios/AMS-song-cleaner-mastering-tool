const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto('http://127.0.0.1:8080/');
  await page.setInputFiles('#fileinput', [path.resolve('music-cleanup-studio/test/noisy-track-2.wav')]);
  await page.waitForFunction(() => document.querySelectorAll('.track').length === 1);
  await page.screenshot({ path: 'music-cleanup-studio/test/artifacts/m1-loaded.png', fullPage: true });
  await page.locator('.track .mini[data-act="play-clean"]').click().catch(() => {});
  await page.click('#processBtn');
  await page.waitForFunction(() => document.querySelectorAll('.pill.done').length === 1, { timeout: 120000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'music-cleanup-studio/test/artifacts/m2-done.png', fullPage: true });
  // how much vertical space does the dock eat?
  const info = await page.evaluate(() => {
    const t = document.querySelector('.transport').getBoundingClientRect();
    return { dockHeight: Math.round(t.height), viewport: window.innerHeight, pct: Math.round(100 * t.height / window.innerHeight) };
  });
  console.log('mobile transport dock:', JSON.stringify(info));
  await browser.close();
})();
