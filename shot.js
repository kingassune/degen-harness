#!/usr/bin/env node
// Render an out/*.html chart to PNG:  node shot.js out/BTC-3d.html [more.html ...]
// Needs Playwright. It is looked for in DEGEN_PLAYWRIGHT, then this folder's node_modules, then ../gdesk/node_modules.
// Browsers: set PLAYWRIGHT_BROWSERS_PATH if they are not in the default cache (shot.js tries ../.cache/ms-playwright too).
'use strict';
const path = require('node:path');
const fs = require('node:fs');
function loadPlaywright() {
  for (const p of [process.env.DEGEN_PLAYWRIGHT, path.join(__dirname, 'node_modules', 'playwright'), path.join(__dirname, '..', 'gdesk', 'node_modules', 'playwright'), 'playwright'].filter(Boolean)) { try { return require(p); } catch { /* next */ } }
  console.log(JSON.stringify({ ok: false, error: 'Playwright not found. Run: npm i playwright && npx playwright install chromium  (or set DEGEN_PLAYWRIGHT)' })); process.exit(1);
}
const cache = path.join(__dirname, '..', '.cache', 'ms-playwright');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
const { chromium } = loadPlaywright();
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] }); const out = [];
  for (const arg of process.argv.slice(2)) {
    const f = path.resolve(arg); const png = f.replace(/\.html$/, '.png');
    const p = await b.newPage({ viewport: { width: 1500, height: 860 }, deviceScaleFactor: 1.5 });
    const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto('file://' + f); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(500); await p.screenshot({ path: png });
    await p.close(); out.push({ png, errs });
  }
  await b.close(); console.log(JSON.stringify(out.length === 1 ? out[0] : out));
})();
