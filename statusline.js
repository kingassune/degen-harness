#!/usr/bin/env node
/**
 * Claude Code status line: equity, open P&L and positions at a glance. Read-only, cached for 20 seconds.
 * settings.json:  "statusLine": { "type": "command", "command": "node /path/to/degen/statusline.js" }
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const CACHE = path.join(__dirname, 'out', '.status.json');
const paint = (c, t) => `\x1b[${c}m${t}\x1b[0m`;
const money = (v) => (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2);
async function hl(body) {
  const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2500) }).catch(() => null);
  return r && r.ok ? r.json().catch(() => null) : null;
}
function render(s, stale) {
  const pos = s.positions.length ? s.positions.map((p) => `${p.side} ${p.coin} ${paint(p.upnl >= 0 ? '32' : '31', money(p.upnl))}`).join('  ') : paint('2', 'flat');
  return `${paint('1;33', 'DEGEN')} $${s.equity.toFixed(2)}  ${pos}${s.resting ? paint('2', `  ${s.resting} resting`) : ''}${stale ? paint('2', '  (stale)') : ''}`;
}
(async () => {
  let cached = null; try { cached = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* none */ }
  if (cached && Date.now() - cached.at < 20000) { console.log(render(cached)); return; }
  let user = process.env.DEGEN_ADDRESS; if (!user) { try { user = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).address; } catch { /* none */ } }
  if (!user) { console.log('DEGEN  no address set'); return; }
  const [spot, a, b, oa, ob] = await Promise.all([hl({ type: 'spotClearinghouseState', user }), hl({ type: 'clearinghouseState', user, dex: '' }), hl({ type: 'clearinghouseState', user, dex: 'xyz' }), hl({ type: 'frontendOpenOrders', user, dex: '' }), hl({ type: 'frontendOpenOrders', user, dex: 'xyz' })]);
  if (!spot || !a) { console.log(cached ? render(cached, true) : 'DEGEN  no data'); return; }
  const usdc = (spot.balances || []).find((x) => x.coin === 'USDC') || { total: 0, hold: 0 };
  const states = [a, b].filter((x) => x && x.marginSummary);
  const s = { at: Date.now(), equity: Number(usdc.total) - Number(usdc.hold) + states.reduce((n, x) => n + Number(x.marginSummary.accountValue), 0),
    positions: states.flatMap((x) => x.assetPositions.map((p) => ({ coin: p.position.coin, side: Number(p.position.szi) > 0 ? 'L' : 'S', upnl: Number(p.position.unrealizedPnl) }))),
    resting: [oa, ob].filter(Array.isArray).flat().filter((o) => !o.reduceOnly && !o.isTrigger).length };
  try { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(s)); } catch { /* read-only */ }
  console.log(render(s));
})();
