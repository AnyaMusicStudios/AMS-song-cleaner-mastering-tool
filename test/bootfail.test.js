// Reproduces "I opened index.html on its own" -> must explain itself, not render unstyled.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
  await page.goto('file:///tmp/lonely/index.html');
  await page.waitForTimeout(600);
  const warningShown = await page.evaluate(() => {
    const b = document.getElementById('bootfail');
    return b && !b.hidden && b.textContent.includes('missing its support files');
  });
  console.log(warningShown ? 'PASS  lone index.html explains what is missing' : 'FAIL  no explanation shown');
  await page.screenshot({ path: '/tmp/lonely/lone.png' });
  await browser.close();
  process.exit(warningShown ? 0 : 1);
})();
