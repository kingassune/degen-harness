// render an out/*.html terrain to PNG:  node shot.js out/BTC-3d.html
const { chromium } = require('/home/assune/gdesk/node_modules/playwright');
(async () => {
  const f = require('path').resolve(process.argv[2]); const png = f.replace(/\.html$/, '.png');
  const b = await chromium.launch({ args: ['--no-sandbox'] }); const p = await b.newPage({ viewport: { width: 1500, height: 860 }, deviceScaleFactor: 1.5 });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto('file://' + f); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(500); await p.screenshot({ path: png });
  await b.close(); console.log(JSON.stringify({ png, errs }));
})();
