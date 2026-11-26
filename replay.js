#!/usr/bin/env node
/**
 * REPLAY — do level setups work, and does the tracker make them better? Read-only, history only.
 *
 *   node replay.js                      # basket of markets, 15m candles
 *   node replay.js BTC xyz:NVDA         # chosen markets
 *   node replay.js --rr 3 --tf 15m      # reward-to-risk of the target (default 3 = a 20% stop with a 60% target)
 *
 * Zones are rebuilt at every candle from the past only, the same way levels.js builds them (swing tops/bottoms on the
 * base timeframe plus 4x and 16x, weighted by timeframe and freshness, clustered within 0.25 x the 4x average range).
 *
 * Two setups, each replayed with and without the tracker as a filter:
 *   FADE      rest a limit at the near edge of the closest strong zone; stop past the far edge; target = rr x the risk.
 *   BREAKOUT  a candle closes through a strong zone on a wide range; enter at the next open; stop back inside the zone.
 * Fees are the ones measured on this account: 0.0932% per side at market, 0.065% for a resting limit.
 * Inside one candle the stop is always assumed to be hit before the target.
 */
'use strict';
const { runTrack, candles } = require('./track.js');
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const JSON_OUT = argv.includes('--json');
const COLOR = !argv.includes('--no-color') && !JSON_OUT && !process.env.NO_COLOR;
const paint = (c) => (t) => (COLOR ? `\x1b[${c}m${t}\x1b[0m` : String(t));
const C = { red: paint('1;31'), green: paint('1;32'), yellow: paint('1;33'), cyan: paint('1;36'), dim: paint('2'), bold: paint('1') };
const pad = (s, n) => String(s).padStart(n); const padE = (s, n) => String(s).padEnd(n);
const TAKER = Number(process.env.DEGEN_FEE_TAKER || 0.000932); const MAKER = Number(process.env.DEGEN_FEE_MAKER || 0.00065);
const RR = Number(flag('rr', 3)); const TF = flag('tf', '15m'); const MIN_SCORE = Number(flag('min-score', 4)); const MAX_HOLD = 96;
const BASKET = ['BTC', 'ETH', 'SOL', 'HYPE', 'ZEC', 'xyz:NVDA', 'xyz:SNDK', 'xyz:GOLD'];
const N = 60;
// a setup is skipped when its stop is so tight that fees eat it: risk must be at least FEE_X round-trip fees (0 = take everything)
const FEE_X = Number(flag('fee-x', 4)); const MIN_RISK = FEE_X * 2 * TAKER;

const agg = (c, end, m, count) => { // rolling m-candle bars ending at index `end` (no clock alignment, so no look-ahead)
  const out = [];
  for (let e = end; e - m + 1 >= 0 && out.length < count; e -= m) { let h = -Infinity; let l = Infinity; for (let k = e - m + 1; k <= e; k += 1) { if (c[k].h > h) h = c[k].h; if (c[k].l < l) l = c[k].l; } out.push({ o: c[e - m + 1].o, h, l, c: c[e].c, age: (end - e) / m }); }
  return out.reverse();
};
const atrOf = (b) => { let s = 0; let n = 0; for (let k = Math.max(1, b.length - 14); k < b.length; k += 1) { s += Math.max(b[k].h - b[k].l, Math.abs(b[k].h - b[k - 1].c), Math.abs(b[k].l - b[k - 1].c)); n += 1; } return n ? s / n : 0; };
function zonesAt(c, k) {
  const piv = []; let atr4 = 0; let atr1 = 0;
  for (const [m, w] of [[1, 2], [4, 3], [16, 5]]) {
    const b = agg(c, k, m, N); if (b.length < 8) continue;
    if (m === 1) atr1 = atrOf(b); if (m === 4) atr4 = atrOf(b);
    for (let i = 2; i < b.length - 2; i += 1) {
      const fresh = w * Math.pow(0.5, (b.length - 1 - i) / 30);
      if (b[i - 2].h < b[i].h && b[i - 1].h < b[i].h && b[i + 1].h < b[i].h && b[i + 2].h < b[i].h) piv.push({ px: b[i].h, w: fresh });
      if (b[i - 2].l > b[i].l && b[i - 1].l > b[i].l && b[i + 1].l > b[i].l && b[i + 2].l > b[i].l) piv.push({ px: b[i].l, w: fresh });
    }
  }
  const tol = (atr4 || atr1 * 2) * 0.25; piv.sort((a, b) => a.px - b.px); const zones = [];
  for (const p of piv) { const z = zones[zones.length - 1]; if (z && p.px - z.lo <= tol) { z.hi = p.px; z.score += p.w; } else zones.push({ lo: p.px, hi: p.px, score: p.w }); }
  return { zones: zones.filter((z) => z.score >= MIN_SCORE), atr1 };
}
function walk(c, k0, dir, entry, stop, target, firstCanTarget) { // returns exit price and reason
  for (let j = k0; j < Math.min(c.length, k0 + MAX_HOLD); j += 1) {
    if (dir > 0 ? c[j].l <= stop : c[j].h >= stop) return { exit: stop, why: 'stop', j };
    if ((firstCanTarget || j > k0) && (dir > 0 ? c[j].h >= target : c[j].l <= target)) return { exit: target, why: 'target', j };
  }
  const j = Math.min(c.length - 1, k0 + MAX_HOLD - 1); return { exit: c[j].c, why: 'time', j };
}
function replay(c) {
  const T = runTrack(c); const byK = new Map(T.map((r) => [r.k, r])); const trades = [];
  const busy = { fade: 0, breakout: 0 };
  for (let k = 1000; k < c.length - 2; k += 1) {
    const tr = byK.get(k); if (!tr) continue;
    const { zones, atr1 } = zonesAt(c, k); if (!zones.length || !atr1) continue;
    const px = c[k].c; const buf = atr1 * 0.3; const nx = c[k + 1];
    const tag = { mode: tr.mode, lock: tr.lock, surprise: tr.surprise, hover: tr.mu[0] };
    // FADE: nearest strong zone on each side, resting limit at its near edge for the next candle
    if (k >= busy.fade) {
      const below = [...zones].reverse().find((z) => z.hi < px); const above = zones.find((z) => z.lo > px);
      for (const [z, dir] of [[below, 1], [above, -1]]) {
        if (!z) continue; const entry = dir > 0 ? z.hi : z.lo; const stop = dir > 0 ? z.lo - buf : z.hi + buf;
        if (dir > 0 ? !(nx.o > entry && nx.l <= entry) : !(nx.o < entry && nx.h >= entry)) continue;
        const risk = Math.abs(entry - stop); if (risk / entry < MIN_RISK) continue; const target = entry + dir * RR * risk; const w = walk(c, k + 1, dir, entry, stop, target, false);
        const gross = (w.exit / entry - 1) * dir; const fee = MAKER + (w.why === 'target' ? MAKER : TAKER);
        trades.push({ setup: 'fade', dir, gross, net: gross - fee, gR: gross / (risk / entry), R: (gross - fee) / (risk / entry), riskPct: risk / entry, why: w.why, ...tag, against: (tr.mode === 'UP' && dir < 0) || (tr.mode === 'DOWN' && dir > 0) });
        busy.fade = w.j + 1; break;
      }
    }
    // BREAKOUT: this candle closed through a strong zone on a wide range
    if (k >= busy.breakout && (c[k].h - c[k].l) >= 1.2 * atr1) {
      const prev = c[k - 1].c;
      const up = zones.find((z) => prev <= z.hi && px > z.hi); const dn = [...zones].reverse().find((z) => prev >= z.lo && px < z.lo);
      const z = up || dn; if (z) {
        const dir = up ? 1 : -1; const entry = nx.o; const stop = dir > 0 ? z.lo - buf : z.hi + buf; const risk = Math.abs(entry - stop);
        if ((entry - stop) * dir > 0 && risk / entry < 0.05 && risk / entry >= MIN_RISK) {
          const target = entry + dir * RR * risk; const w = walk(c, k + 1, dir, entry, stop, target, true);
          const gross = (w.exit / entry - 1) * dir; const fee = TAKER + (w.why === 'target' ? MAKER : TAKER);
          trades.push({ setup: 'breakout', dir, gross, net: gross - fee, gR: gross / (risk / entry), R: (gross - fee) / (risk / entry), riskPct: risk / entry, why: w.why, ...tag, withLock: (tr.mode === 'UP' && dir > 0) || (tr.mode === 'DOWN' && dir < 0), withSurprise: tr.surprise * dir >= 2 });
          busy.breakout = w.j + 1;
        }
      }
    }
  }
  return trades;
}
function stats(t) {
  const n = t.length; if (!n) return { n: 0 };
  const R = t.map((x) => x.R); const mean = R.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(R.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1e-9;
  const wins = t.filter((x) => x.net > 0).length; const gw = t.filter((x) => x.net > 0).reduce((a, x) => a + x.R, 0); const gl = -t.filter((x) => x.net <= 0).reduce((a, x) => a + x.R, 0);
  return { n, winPct: wins / n * 100, grossR: t.reduce((a, x) => a + x.gR, 0) / n, avgR: mean, totalR: mean * n, pf: gl ? gw / gl : Infinity, t: mean / (sd / Math.sqrt(n)), avgRiskPct: t.reduce((a, x) => a + x.riskPct, 0) / n * 100, avgNetPct: t.reduce((a, x) => a + x.net, 0) / n * 100, targetPct: t.filter((x) => x.why === 'target').length / n * 100 };
}
const VARIANTS = [
  ['fade', 'every fade', (x) => true],
  ['fade', 'tracker says CHOP', (x) => x.mode === 'CHOP'],
  ['fade', 'tracker not locked against', (x) => !x.against],
  ['fade', 'tracker locked against', (x) => x.against],
  ['breakout', 'every breakout', (x) => true],
  ['breakout', 'tracker locked with it', (x) => x.withLock],
  ['breakout', 'surprise 2+ sigma with it', (x) => x.withSurprise],
  ['breakout', 'neither lock nor surprise', (x) => !x.withLock && !x.withSurprise],
];
async function main() {
  const list = argv.filter((a, k) => !a.startsWith('--') && !(k > 0 && ['--rr', '--tf', '--min-score'].includes(argv[k - 1])));
  const coins = list.length ? list.map((x) => { const i = x.indexOf(':'); return i === -1 ? x.toUpperCase() : x.slice(0, i).toLowerCase() + ':' + x.slice(i + 1).toUpperCase(); }) : BASKET;
  const all = []; const per = []; let days = 0;
  for (const coin of coins) { const c = await candles(coin, TF, 5000); if (c.length < 1500) continue; const t = replay(c); const d = (c[c.length - 1].t - c[1000].t) / 86400e3; days += d; per.push({ coin, days: d, fade: stats(t.filter((x) => x.setup === 'fade')), breakout: stats(t.filter((x) => x.setup === 'breakout')) }); all.push(...t); }
  const rows = VARIANTS.map(([setup, name, f]) => ({ setup, name, ...stats(all.filter((x) => x.setup === setup && f(x))) }));
  const breakeven = 1 / (1 + RR) * 100;
  if (JSON_OUT) { console.log(JSON.stringify({ tf: TF, rr: RR, marketDays: days, rows, per }, null, 1)); return; }
  console.log(`\n${C.cyan('LEVEL SETUPS + TRACKER')}  ${coins.length} markets, ${TF} candles, ${days.toFixed(0)} market-days   target = ${RR} x risk   stop at least ${(MIN_RISK * 100).toFixed(2)}% of price   ${C.dim('fees: market ' + (TAKER * 100).toFixed(3) + '%, limit ' + (MAKER * 100).toFixed(3) + '% per side')}`);
  console.log(C.dim(`\n${padE('setup', 9)} ${padE('filter', 28)} ${pad('trades', 6)} ${pad('win', 5)} ${pad('hit target', 10)} ${pad('R no fee', 8)} ${pad('avg R', 7)} ${pad('total R', 8)} ${pad('PF', 5)} ${pad('t', 5)} ${pad('avg stop', 9)}`));
  for (const r of rows) {
    if (!r.n) { console.log(`${padE(r.setup, 9)} ${padE(r.name, 28)} ${pad(0, 6)}`); continue; }
    const cc = r.avgR >= 0 ? C.green : C.red;
    console.log(`${C.yellow(padE(r.setup, 9))} ${padE(r.name, 28)} ${pad(r.n, 6)} ${pad(r.winPct.toFixed(0) + '%', 5)} ${pad(r.targetPct.toFixed(0) + '%', 10)} ${pad((r.grossR >= 0 ? '+' : '') + r.grossR.toFixed(3), 8)} ${cc(pad((r.avgR >= 0 ? '+' : '') + r.avgR.toFixed(3), 7))} ${cc(pad((r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(1), 8))} ${pad(r.pf.toFixed(2), 5)} ${pad(r.t.toFixed(1), 5)} ${pad(r.avgRiskPct.toFixed(2) + '%', 9)}`);
  }
  console.log(C.dim(`\nR = result as a multiple of the amount risked, after fees (-1 = a full stop-out plus fees, +${RR} = target). Without fees the break-even hit rate is ${breakeven.toFixed(0)}%.`));
  console.log(C.dim(`t = standard errors from zero: under 2 is noise. Eight filters were tried, so one or two looking good by luck is expected.\n`));
  console.log(C.dim(`${padE('market', 10)} ${pad('days', 5)} | ${pad('fades', 6)} ${pad('avg R', 7)} | ${pad('breaks', 6)} ${pad('avg R', 7)}`));
  for (const p of per) console.log(`${padE(p.coin, 10)} ${pad(p.days.toFixed(0), 5)} | ${pad(p.fade.n, 6)} ${pad(p.fade.n ? p.fade.avgR.toFixed(3) : '-', 7)} | ${pad(p.breakout.n, 6)} ${pad(p.breakout.n ? p.breakout.avgR.toFixed(3) : '-', 7)}`);
  console.log('');
}
main().catch((e) => { require('./lib.js').bail(e); });
