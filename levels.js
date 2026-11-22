#!/usr/bin/env node
/**
 * LEVELS — multi-timeframe candle tops/bottoms and zones for picking stops. Read-only, no wallet.
 *
 *   node levels.js BTC                 # timeframes + zones + stop ideas
 *   node levels.js xyz:NVDA --budget 20   # budget = max % of MARGIN you accept losing at the stop
 *   node levels.js ETH --json
 *
 * "margin hit" = price distance to the level x leverage = % of your margin gone if stopped there.
 */
'use strict';
const TFS = [['5m', 300, 1], ['15m', 900, 2], ['1h', 3600, 3], ['4h', 14400, 5], ['1d', 86400, 8]];
const N = 60;

async function hl(body) {
  for (let k = 0; ; k += 1) { // the public API rate-limits bursts: retry a null/429 a few times
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j != null || k >= 4) return j;
    await new Promise((res) => setTimeout(res, 700 * (k + 1)));
  }
}
const fmt = (v) => (v >= 1000 ? v.toFixed(0) : v >= 10 ? v.toFixed(2) : v >= 0.1 ? v.toFixed(4) : v.toPrecision(4));
const pct = (a, b) => ((a / b - 1) * 100);
const pad = (s, n) => String(s).padStart(n);
// colours: on by default, off with --no-color, NO_COLOR=1 or --json
const COLOR = !process.argv.includes('--no-color') && !process.argv.includes('--json') && !process.env.NO_COLOR;
const paint = (code) => (t) => (COLOR ? `\x1b[${code}m${t}\x1b[0m` : String(t));
const C = { red: paint('31'), green: paint('32'), yellow: paint('1;33'), cyan: paint('1;36'), dim: paint('2'), bold: paint('1'), alarm: paint('1;37;41'), redB: paint('1;31'), greenB: paint('1;32') };

async function main() {
  const argv = process.argv.slice(2);
  let coin = argv.find((a) => !a.startsWith('--'));
  if (!coin) { console.log('usage: levels.js <COIN> [--budget PCT] [--json]'); process.exit(1); }
  const i = coin.indexOf(':');
  coin = i === -1 ? coin.toUpperCase() : coin.slice(0, i).toLowerCase() + ':' + coin.slice(i + 1).toUpperCase();
  const bi = argv.indexOf('--budget');
  const budget = bi === -1 ? 20 : Number(argv[bi + 1]);
  const json = argv.includes('--json');

  const dex = i === -1 ? '' : coin.slice(0, i);
  const [meta] = await hl({ type: 'metaAndAssetCtxs', dex });
  const u = meta.universe.find((x) => x.name.toLowerCase() === coin.toLowerCase());
  if (!u) { console.log(`unknown market ${coin}`); process.exit(1); }
  const maxLev = u.maxLeverage; const halfLev = Math.max(1, Math.floor(maxLev / 2));
  const now = Date.now();
  const frames = []; const pivots = [];
  let price = 0;
  for (const [tf, secs, weight] of TFS) {
    const raw = await hl({ type: 'candleSnapshot', req: { coin: u.name, interval: tf, startTime: now - secs * 1000 * N, endTime: now } });
    if (!Array.isArray(raw)) continue;
    const c = raw.map((x) => ({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c }));
    if (c.length < 5) continue;
    price = c[c.length - 1].c;
    const trs = c.slice(1).map((x, k) => Math.max(x.h - x.l, Math.abs(x.h - c[k].c), Math.abs(x.l - c[k].c)));
    const atr = trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length);
    const cur = c[c.length - 1]; const prev = c[c.length - 2];
    const last20 = c.slice(-20);
    frames.push({ tf, curHigh: cur.h, curLow: cur.l, prevHigh: prev.h, prevLow: prev.l, prevClose: prev.c,
      hi20: Math.max(...last20.map((x) => x.h)), lo20: Math.min(...last20.map((x) => x.l)), atr, atrPct: atr / price * 100,
      dir: prev.c > prev.o ? 'up' : 'down' });
    // swing pivots: a top/bottom not beaten by the 2 candles either side (closed candles only)
    for (let k = 2; k < c.length - 2; k += 1) {
      const w = [c[k - 2], c[k - 1], c[k + 1], c[k + 2]];
      // older levels count for less: a level's chance of holding fades with time (arXiv 2101.07410). Half-life 30 candles.
      const fresh = weight * Math.pow(0.5, (now - c[k].t) / (secs * 1000 * 30));
      if (w.every((x) => x.h < c[k].h)) pivots.push({ px: c[k].h, kind: 'top', tf, weight: fresh });
      if (w.every((x) => x.l > c[k].l)) pivots.push({ px: c[k].l, kind: 'bottom', tf, weight: fresh });
    }
    pivots.push({ px: prev.h, kind: 'top', tf, weight: weight * 0.5 }, { px: prev.l, kind: 'bottom', tf, weight: weight * 0.5 });
  }
  const atr1h = (frames.find((f) => f.tf === '1h') || frames[0]).atr;
  const atr15 = (frames.find((f) => f.tf === '15m') || frames[0]).atr;
  // cluster pivots into zones: anything within 0.35 x the 1h ATR is the same zone
  const tol = atr1h * 0.25; // max zone width, so zones stay tight enough to trade
  pivots.sort((a, b) => a.px - b.px);
  const zones = [];
  for (const p of pivots) {
    const z = zones[zones.length - 1];
    if (z && p.px - z.lo <= tol) { z.hi = p.px; z.score += p.weight; z.touches += 1; z.tfs.add(p.tf); } else zones.push({ lo: p.px, hi: p.px, score: p.weight, touches: 1, tfs: new Set([p.tf]) });
  }
  const order = TFS.map((t) => t[0]);
  const tidy = (z) => ({ lo: z.lo, hi: z.hi, score: Math.round(z.score * 10) / 10, touches: z.touches, tfs: [...z.tfs].sort((a, b) => order.indexOf(a) - order.indexOf(b)) });
  const above = zones.filter((z) => z.lo > price).map(tidy).slice(0, 6);
  const below = zones.filter((z) => z.hi < price).map(tidy).reverse().slice(0, 6);
  const inside = zones.filter((z) => z.lo <= price && z.hi >= price).map(tidy);
  const buf = atr15 * 0.3; // breathing room past the zone edge so a wick does not tag the stop
  const stopFor = (z, side) => {
    const stop = side === 'short' ? z.hi + buf : z.lo - buf;
    const dist = Math.abs(pct(stop, price));
    return { stop, dist, hitHalf: dist * halfLev, hitMax: dist * maxLev };
  };
  const out = { coin: u.name, price, maxLev, halfLev, budget, frames, above, inside, below,
    shortStops: above.map((z) => ({ zone: z, ...stopFor(z, 'short') })), longStops: below.map((z) => ({ zone: z, ...stopFor(z, 'long') })) };
  if (json) { console.log(JSON.stringify(out, null, 1)); return; }

  console.log(`\n${C.yellow(u.name + '  price ' + fmt(price))}   max leverage ${C.bold(maxLev + 'x')} (half ${halfLev}x)   ${C.dim(new Date().toISOString().slice(0, 16) + 'Z')}`);
  console.log(C.cyan('\nTIMEFRAMES') + '  (top/bottom of the forming candle, the last closed candle, and the last 20 candles)');
  console.log(`${pad('tf', 4)} ${pad('now top', 10)} ${pad('now bot', 10)} | ${pad('last top', 10)} ${pad('last bot', 10)} ${pad('dir', 5)} | ${pad('20 top', 10)} ${pad('20 bot', 10)} | ${pad('avg range', 10)}`);
  for (const f of frames) console.log(`${pad(f.tf, 4)} ${C.red(pad(fmt(f.curHigh), 10))} ${C.green(pad(fmt(f.curLow), 10))} | ${C.red(pad(fmt(f.prevHigh), 10))} ${C.green(pad(fmt(f.prevLow), 10))} ${(f.dir === 'up' ? C.greenB : C.redB)(pad(f.dir, 5))} | ${C.red(pad(fmt(f.hi20), 10))} ${C.green(pad(fmt(f.lo20), 10))} | ${pad(fmt(f.atr) + ' ' + f.atrPct.toFixed(2) + '%', 16)}`);
  const liqOf = (lev) => (lev === maxLev ? 100 / maxLev / 2 : 100 / halfLev - 100 / maxLev / 2);
  const cell = (lev, hit, dist) => {
    if (dist >= liqOf(lev)) return `${lev}x: ${C.alarm(' LIQ ')}     `;
    return `${lev}x: ${(hit <= budget ? C.greenB : C.redB)(pad(hit.toFixed(0) + '%', 5) + (hit <= budget ? ' ok  ' : ' OVER'))}`;
  };
  const row = (z, s, col) => {
    const strong = z.tfs.some((t) => t === '4h' || t === '1d') ? C.bold : (t) => t;
    return `${strong(col(pad(fmt(z.lo) + (z.hi > z.lo ? '-' + fmt(z.hi) : ''), 19)))} ${pad(z.touches, 4)} ${pad(z.score, 5)}  ${C.dim(pad(z.tfs.join(','), 15))} | stop ${C.yellow(pad(fmt(s.stop), 9))} ${pad(s.dist.toFixed(2) + '%', 7)} | ${cell(halfLev, s.hitHalf, s.dist)}  ${cell(maxLev, s.hitMax, s.dist)}`;
  };
  const head = `${pad('zone', 19)} ${pad('hits', 4)} ${pad('score', 5)}  ${pad('timeframes', 15)} | ${pad('stop past zone', 22)} | margin hit if stopped (budget ${budget}%)`;
  console.log(C.redB(`\nZONES ABOVE = resistance, where a SHORT's stop goes (furthest first)`));
  console.log(C.dim(head));
  for (const s of [...out.shortStops].reverse()) console.log(row(s.zone, s, C.red));
  console.log(`${C.yellow(pad('--- price ' + fmt(price) + ' ---', 19))}${inside.length ? '   (inside zone ' + inside.map((z) => fmt(z.lo) + '-' + fmt(z.hi)).join(', ') + ')' : ''}`);
  console.log(C.greenB(`ZONES BELOW = support, where a LONG's stop goes, and targets for shorts (nearest first)`));
  for (const s of out.longStops) console.log(row(s.zone, s, C.green));
  console.log(C.cyan(`\nYOUR ${budget}% STOP (percent of margin, GDEX style) lands at:`));
  for (const lev of [halfLev, maxLev]) {
    const mv = budget / lev / 100;
    const liq = lev === maxLev ? 100 / maxLev / 2 : 100 / halfLev - 100 / maxLev / 2;
    console.log(`  ${pad(lev + 'x', 4)}  price moves ${(mv * 100).toFixed(2)}%   short stop ${C.red(fmt(price * (1 + mv)))}   long stop ${C.green(fmt(price * (1 - mv)))}   ${mv * 100 >= liq ? C.alarm(' PAST LIQUIDATION ') : ''}`);
  }
  console.log(C.dim(`\nstop = zone edge + ${fmt(buf)} breathing room (0.3 x the 15m average range). score = hits weighted by timeframe (1d counts most). Bold zone = seen on 4h or 1d.`));
  console.log(C.dim(`Liquidation sits roughly ${(100 / maxLev / 2).toFixed(2)}% away at ${maxLev}x and ${(100 / halfLev - 100 / maxLev / 2).toFixed(2)}% at ${halfLev}x; a stop further than that never triggers.\n`));
}
main().catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
