// Screenshots demo.html into docs/screenshot*.png with a headless Chromium (playwright).
//   (once) npx playwright@1.48.2 install chromium      then   node tools/screenshot/shoot.js
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  for (const [bg, out] of [['city', 'screenshot.png'], ['meadow', 'screenshot-meadow.png']]) {
    await page.goto('file://' + path.join(__dirname, 'demo.html') + '?bg=' + bg);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(__dirname, '..', '..', 'docs', out) });
    console.log('docs/' + out);
  }
  await page.goto('file://' + path.join(__dirname, 'demo.html') + '?bg=city');   // the work board, open
  await page.waitForTimeout(1200);
  await page.keyboard.press('t'); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, '..', '..', 'docs', 'screenshot-board.png') });
  console.log('docs/screenshot-board.png');
  await page.evaluate(() => { select('e1f2a3b4-11', false); });                // Research Companion, open on one experiment
  await page.keyboard.press('e'); await page.waitForTimeout(200);
  await page.click('#rsAllBtn'); await page.click('.rexp[data-e="e1"] .rrow'); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, '..', '..', 'docs', 'screenshot-research.png') });
  console.log('docs/screenshot-research.png');
  await browser.close();
})();
