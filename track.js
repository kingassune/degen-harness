#!/usr/bin/env node
/**
 * TRACK — a radar-style target tracker on price. Read-only.
 *
 * Radar follows a maneuvering aircraft by running several motion models at once and letting the data vote
 * (the Interacting Multiple Model filter, IMM). Here the "target" is log price and the three models are:
 *   HOVER    = no velocity, price wobbles round a level        -> chop
 *   CRUISE   = steady velocity                                 -> trend
 *   MANEUVER = velocity changing fast                          -> turn / breakout / news
 * Each candle the filter updates: where price "really" is (track), how fast it is going (velocity),
 * how sure it is (lock), which model fits (mode), and how surprised it was (surprise, in sigmas).
 *
 *   node track.js BTC                    # read-out + cone for the next candles
 *   node track.js BTC --tf 5m --png      # also write out/<coin>-track.html
 *   node track.js BTC --backtest         # replay the rules on history, after fees. Add --tf 5m|15m|1h
 *   node track.js --backtest-all         # the same over a basket of markets and timeframes
 *   node track.js --pairs                # replay on spreads: the ratio of two related markets (--pair ETH BTC for one)
 *   add --adaptive to any of them        # surprise-driven model switching (arXiv 2610.11242) instead of fixed
 *
 * Nothing here predicts. It measures the current motion with less lag and less noise than eyeballing candles.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const JSON_OUT = argv.includes('--json');
const COLOR = !argv.includes('--no-color') && !JSON_OUT && !process.env.NO_COLOR;
const paint = (c) => (t) => (COLOR ? `\x1b[${c}m${t}\x1b[0m` : String(t));
const C = { red: paint('1;31'), green: paint('1;32'), yellow: paint('1;33'), cyan: paint('1;36'), dim: paint('2'), bold: paint('1'), go: paint('1;30;42'), goS: paint('1;37;41'), chop: paint('1;30;43') };
const pad = (s, n) => String(s).padStart(n); const padE = (s, n) => String(s).padEnd(n);
const fmt = (v) => (v >= 1000 ? v.toFixed(0) : v >= 10 ? v.toFixed(2) : v >= 0.1 ? v.toFixed(4) : v.toPrecision(4));
const SECS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
// Fees measured on this account's own fills (2026-11-22): a market order costs 0.0932% of position per side
// (HyperLiquid taker 0.0432% + GDEX builder 0.05%). A resting limit order is assumed at 0.065% (maker 0.015% + builder 0.05%).
const TAKER = Number(process.env.DEGEN_FEE_TAKER || 0.000932); const MAKER = Number(process.env.DEGEN_FEE_MAKER || 0.00065);
let LEGS = 1; // a pair trades two markets, so every fee is paid twice
const FEE_RT = 2 * TAKER;

async function hl(body) {
  for (let k = 0; ; k += 1) {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j != null || k >= 5) return j;
    await new Promise((res) => setTimeout(res, 900 * (k + 1)));
  }
}
async function candles(coin, tf, n) {
  const now = Date.now();
  const raw = await hl({ type: 'candleSnapshot', req: { coin, interval: tf, startTime: now - SECS[tf] * 1000 * n, endTime: now } });
  return Array.isArray(raw) ? raw.map((x) => ({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v * +x.c })) : [];
}

// ---------- the filter ----------
// State = [log price, velocity per candle]. All noise levels are in units of sigma, the running size of one candle's move,
// so the same settings work on BTC at 5m and a stock perp at 1h. These numbers are fixed, not fitted to any market.
const MODELS = [
  { name: 'HOVER', F: [[1, 0], [0, 0]], qp: 0.35, qv: 0.0 },     // velocity forced to zero each step
  { name: 'CRUISE', F: [[1, 1], [0, 1]], qp: 0.30, qv: 0.04 },   // velocity persists
  { name: 'MANEUVER', F: [[1, 1], [0, 1]], qp: 0.90, qv: 0.45 }, // velocity free to change
];
const R_SIG = 0.8;                       // a close is a noisy reading of the "true" track
const ADAPTIVE = process.argv.includes('--adaptive');
const STAY = 0.94;                       // chance a model stays the right one from candle to candle
const TRANS = MODELS.map((_, i) => MODELS.map((__, j) => (i === j ? STAY : (1 - STAY) / (MODELS.length - 1))));
const mul = (A, B) => [[A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]], [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]]];
const tr = (A) => [[A[0][0], A[1][0]], [A[0][1], A[1][1]]];

/** Run the IMM over closes. Returns one record per candle, each using only data up to that candle. */
function runTrack(c, opts = {}) {
  const adaptive = opts.adaptive != null ? opts.adaptive : ADAPTIVE; let nis = 1;
  const z0 = Math.log(c[0].c);
  let xs = MODELS.map(() => [z0, 0]); let Ps = MODELS.map(() => [[1e-6, 0], [0, 1e-8]]); let mu = [0.6, 0.3, 0.1];
  let s2 = 0; const out = [];
  for (let k = 1; k < Math.min(c.length, 30); k += 1) s2 += Math.log(c[k].c / c[k - 1].c) ** 2;
  s2 = s2 / Math.max(1, Math.min(c.length, 30) - 1) || 1e-8;
  for (let k = 1; k < c.length; k += 1) {
    const z = Math.log(c[k].c); const sig = Math.sqrt(s2); const R = (R_SIG * sig) ** 2;
    // 1. mix: each model starts from a blend of all models' last estimates
    // fixed switching by default. Adaptive: a big surprise on the last candle raises the chance that the target is now maneuvering.
    let TR = TRANS;
    if (adaptive) { const m = Math.min(0.5, 0.03 + 0.04 * Math.max(0, nis - 1)); TR = [[1 - m - 0.03, 0.03, m], [0.03, 1 - m - 0.03, m], [0.03, 0.03, 0.94]]; }
    const cj = MODELS.map((_, j) => MODELS.reduce((a, __, i) => a + TR[i][j] * mu[i], 0));
    const x0 = []; const P0 = [];
    for (let j = 0; j < MODELS.length; j += 1) {
      const w = MODELS.map((_, i) => TR[i][j] * mu[i] / cj[j]);
      const x = [0, 0]; for (let i = 0; i < MODELS.length; i += 1) { x[0] += w[i] * xs[i][0]; x[1] += w[i] * xs[i][1]; }
      const P = [[0, 0], [0, 0]];
      for (let i = 0; i < MODELS.length; i += 1) { const d0 = xs[i][0] - x[0]; const d1 = xs[i][1] - x[1]; P[0][0] += w[i] * (Ps[i][0][0] + d0 * d0); P[0][1] += w[i] * (Ps[i][0][1] + d0 * d1); P[1][0] += w[i] * (Ps[i][1][0] + d1 * d0); P[1][1] += w[i] * (Ps[i][1][1] + d1 * d1); }
      x0.push(x); P0.push(P);
    }
    // 2. each model predicts, then corrects with the new close
    const L = []; let predP = 0; let predS = 0;
    for (let j = 0; j < MODELS.length; j += 1) {
      const M = MODELS[j]; const xp = [M.F[0][0] * x0[j][0] + M.F[0][1] * x0[j][1], M.F[1][0] * x0[j][0] + M.F[1][1] * x0[j][1]];
      const Pp = mul(mul(M.F, P0[j]), tr(M.F)); Pp[0][0] += (M.qp * sig) ** 2; Pp[1][1] += (M.qv * sig) ** 2 + 1e-14;
      const y = z - xp[0]; const S = Pp[0][0] + R; const K = [Pp[0][0] / S, Pp[1][0] / S];
      xs[j] = [xp[0] + K[0] * y, xp[1] + K[1] * y];
      Ps[j] = [[Pp[0][0] - K[0] * Pp[0][0], Pp[0][1] - K[0] * Pp[0][1]], [Pp[1][0] - K[1] * Pp[0][0], Pp[1][1] - K[1] * Pp[0][1]]];
      L.push(Math.exp(-0.5 * y * y / S) / Math.sqrt(2 * Math.PI * S) + 1e-300);
      predP += cj[j] * xp[0]; predS += cj[j] * (S + xp[0] * xp[0]);
    }
    predS = Math.max(predS - predP * predP, 1e-16);
    // 3. the data votes on which model is right
    const tot = L.reduce((a, l, j) => a + l * cj[j], 0); mu = L.map((l, j) => l * cj[j] / tot);
    // 4. combined track
    const x = [0, 0]; for (let j = 0; j < MODELS.length; j += 1) { x[0] += mu[j] * xs[j][0]; x[1] += mu[j] * xs[j][1]; }
    let Pvv = 0; let Ppp = 0; for (let j = 0; j < MODELS.length; j += 1) { Pvv += mu[j] * (Ps[j][1][1] + (xs[j][1] - x[1]) ** 2); Ppp += mu[j] * (Ps[j][0][0] + (xs[j][0] - x[0]) ** 2); }
    const sdV = Math.sqrt(Pvv);
    const pTrend = mu[1] + mu[2]; const lock = sdV ? x[1] / sdV : 0;
    const mode = mu[0] >= 0.6 ? 'CHOP' : (pTrend >= 0.6 && Math.abs(lock) >= 1.5) ? (x[1] > 0 ? 'UP' : 'DOWN') : mu[2] >= 0.45 ? 'TURNING' : 'UNCLEAR';
    out.push({ k, t: c[k].t, track: Math.exp(x[0]), logTrack: x[0], vel: x[1], sdV, lock, sig, band: Math.sqrt(predS), surprise: (z - predP) / Math.sqrt(predS), mu: [...mu], mode, sdP: Math.sqrt(Ppp) });
    nis = ((z - predP) ** 2) / predS;
    const r = Math.log(c[k].c / c[k - 1].c); s2 = 0.97 * s2 + 0.03 * r * r; // sigma adapts after the candle is used
  }
  return out;
}

// ---------- replay of two simple rules, entries at the NEXT candle's open, fees included ----------
function backtest(c, T) {
  const trades = []; let busyUntil = 0;
  const byK = new Map(T.map((r) => [r.k, r]));
  for (let k = 160; k < c.length - 2; k += 1) {
    if (k < busyUntil) continue;
    const r = byK.get(k); const prev = byK.get(k - 1); if (!r || !prev) continue;
    let entry = c[k + 1].o; let rule = null; let dir = 0; let stop; let target = null; let maxHold; let fee = FEE_RT * LEGS; let noTargetOnFirst = false;
    // band-limit: while hovering, rest a buy at the lower band and a sell at the upper band for the next candle (the way chop is
    // actually traded with limit orders). Filled only if the next candle reaches the band. Target = the track, as a limit.
    const lo = r.track * Math.exp(-1.5 * r.band); const hi = r.track * Math.exp(1.5 * r.band); const nx = c[k + 1];
    if (r.mode === 'CHOP' && nx.o > lo && nx.o < hi && (nx.l <= lo || nx.h >= hi) && (r.track / lo - 1) > 2 * MAKER * LEGS) {
      rule = 'band-limit'; dir = nx.l <= lo ? 1 : -1; entry = dir > 0 ? lo : hi; target = r.track; stop = entry * Math.exp(-dir * 1.5 * r.band); maxHold = 8; noTargetOnFirst = true;
    } else if (r.mode === 'CHOP' && Math.abs(r.surprise) >= 1.5) { // hovering target jumped: fade it back to the track
      rule = 'chop-fade'; dir = r.surprise > 0 ? -1 : 1; target = r.track; stop = entry * Math.exp(-dir * 1.5 * r.band); maxHold = 8;
      if ((target - entry) * dir <= entry * FEE_RT * LEGS) continue; // not enough room to pay the fees
    } else if ((r.mode === 'UP' || r.mode === 'DOWN') && prev.mode !== r.mode && Math.abs(r.lock) >= 2) { // fresh lock on a moving target
      rule = 'trend-ride'; dir = r.mode === 'UP' ? 1 : -1; stop = entry * Math.exp(-dir * 2 * r.band); maxHold = 24;
    } else continue;
    let exit = null; let why = ''; let j = k + 1;
    for (; j < Math.min(c.length, k + 1 + maxHold); j += 1) {
      const x = c[j];
      if (dir > 0 ? x.l <= stop : x.h >= stop) { exit = stop; why = 'stop'; break; }            // stop is checked first: worst case inside a candle
      if (target != null && !(noTargetOnFirst && j === k + 1) && (dir > 0 ? x.h >= target : x.l <= target)) { exit = target; why = 'target'; break; }
      const s = byK.get(j);
      if (rule === 'trend-ride' && s && (s.vel * dir <= 0 || Math.abs(s.lock) < 0.5)) { exit = x.c; why = 'lock lost'; break; }
    }
    if (exit == null) { j = Math.min(c.length - 1, k + maxHold); exit = c[j].c; why = 'time'; }
    const gross = (exit / entry - 1) * dir;
    if (rule === 'band-limit') fee = (MAKER + (why === 'target' ? MAKER : TAKER)) * LEGS;
    trades.push({ rule, dir, k, entry, exit, why, gross, net: gross - fee, stopDist: Math.abs(stop / entry - 1), bars: j - k });
    busyUntil = j + 1;
  }
  return trades;
}
function stats(tr) {
  const n = tr.length; if (!n) return { n: 0 };
  const net = tr.map((t) => t.net); const wins = net.filter((x) => x > 0);
  const sum = net.reduce((a, b) => a + b, 0); const mean = sum / n; const sd = Math.sqrt(net.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1e-9;
  const gw = wins.reduce((a, b) => a + b, 0); const gl = -net.filter((x) => x <= 0).reduce((a, b) => a + b, 0);
  return { n, winPct: wins.length / n * 100, avgGrossPct: tr.reduce((a, t) => a + t.gross, 0) / n * 100, avgNetPct: mean * 100, totalNetPct: sum * 100, profitFactor: gl ? gw / gl : Infinity, tStat: mean / (sd / Math.sqrt(n)), avgStopPct: tr.reduce((a, t) => a + t.stopDist, 0) / n * 100, avgBars: tr.reduce((a, t) => a + t.bars, 0) / n };
}
const normCoin = (coin) => { const i = coin.indexOf(':'); return i === -1 ? coin.toUpperCase() : coin.slice(0, i).toLowerCase() + ':' + coin.slice(i + 1).toUpperCase(); };

async function pairCandles(a, b, tf, n) {
  const A = await candles(a, tf, n); const B = new Map((await candles(b, tf, n)).map((x) => [x.t, x]));
  // only closes are comparable across two markets, so the pair candle's high/low are just its open and close
  return A.filter((x) => B.has(x.t)).map((x) => { const y = B.get(x.t); const o = x.o / y.o; const cl = x.c / y.c; return { t: x.t, o, c: cl, h: Math.max(o, cl), l: Math.min(o, cl), v: 0 }; });
}
async function backtestCmd(list, tfs) {
  const rows = []; const pool = { 'band-limit': [], 'chop-fade': [], 'trend-ride': [] };
  for (const coin of list) for (const tf of tfs) {
    const c = Array.isArray(coin) ? await pairCandles(coin[0], coin[1], tf, 5000) : await candles(coin, tf, 5000); if (c.length < 400) continue;
    const name = Array.isArray(coin) ? coin.map((x) => x.replace(/^.*:/, '')).join('/') : coin;
    const tr = backtest(c, runTrack(c));
    for (const rule of Object.keys(pool)) { const sub = tr.filter((t) => t.rule === rule); pool[rule].push(...sub); rows.push({ coin: name, tf, rule, candles: c.length, days: (c[c.length - 1].t - c[0].t) / 86400e3, ...stats(sub) }); }
  }
  const total = Object.fromEntries(Object.entries(pool).map(([r, t]) => [r, stats(t)]));
  if (JSON_OUT) { console.log(JSON.stringify({ feeRoundTripPct: FEE_RT * 100, rows, total }, null, 1)); return; }
  console.log(`\n${C.cyan('TRACKER REPLAY')}  entries at the next candle's open, stop checked before target. Fees: market ${(TAKER * 100).toFixed(3)}% per side, limit ${(MAKER * 100).toFixed(3)}% per side${LEGS > 1 ? ', x' + LEGS + ' legs' : ''}${ADAPTIVE ? '   [adaptive switching]' : ''}`);
  console.log(C.dim(`\n${padE('market', 10)} ${pad('tf', 4)} ${padE('rule', 11)} ${pad('days', 5)} ${pad('trades', 6)} ${pad('win', 5)} ${pad('avg gross', 10)} ${pad('avg net', 9)} ${pad('total net', 10)} ${pad('PF', 5)} ${pad('t', 5)} ${pad('avg stop', 9)}`));
  const line = (name, tf, rule, days, s) => { if (!s.n) return `${padE(name, 10)} ${pad(tf, 4)} ${padE(rule, 11)} ${pad(days, 5)} ${pad(0, 6)}`; const cc = s.avgNetPct >= 0 ? C.green : C.red; return `${C.yellow(padE(name, 10))} ${pad(tf, 4)} ${padE(rule, 11)} ${pad(days, 5)} ${pad(s.n, 6)} ${pad(s.winPct.toFixed(0) + '%', 5)} ${pad((s.avgGrossPct >= 0 ? '+' : '') + s.avgGrossPct.toFixed(3) + '%', 10)} ${cc(pad((s.avgNetPct >= 0 ? '+' : '') + s.avgNetPct.toFixed(3) + '%', 9))} ${cc(pad((s.totalNetPct >= 0 ? '+' : '') + s.totalNetPct.toFixed(1) + '%', 10))} ${pad(s.profitFactor.toFixed(2), 5)} ${pad(s.tStat.toFixed(1), 5)} ${pad(s.avgStopPct.toFixed(2) + '%', 9)}`; };
  for (const r of rows) console.log(line(r.coin, r.tf, r.rule, r.days.toFixed(0), r));
  console.log(C.dim('-'.repeat(100)));
  for (const [rule, s] of Object.entries(total)) console.log(line('ALL', '', rule, '', s));
  console.log(C.dim(`\nPercents are of position size, before leverage. PF = profit factor (wins / losses). t = how many standard errors the average is from zero; under 2 is noise.\n`));
}

async function one() {
  let coin = argv.find((a, k) => !a.startsWith('--') && !(k > 0 && ['--tf', '--top'].includes(argv[k - 1])));
  if (!coin) { console.log('usage: track.js <COIN> [--tf 15m] [--png] [--backtest]   |   track.js --backtest-all'); process.exit(1); }
  coin = normCoin(coin); const tf = flag('tf', '15m');
  if (argv.includes('--backtest')) return backtestCmd([coin], flag('tf', null) ? [tf] : ['5m', '15m', '1h']);
  const i = coin.indexOf(':');
  const [meta] = await hl({ type: 'metaAndAssetCtxs', dex: i === -1 ? '' : coin.slice(0, i) });
  const u = meta.universe.find((x) => x.name.toLowerCase() === coin.toLowerCase());
  if (!u) { console.log(`unknown market ${coin}`); process.exit(1); }
  const maxLev = u.maxLeverage; const c = await candles(u.name, tf, 600);
  if (c.length < 200) { console.log('not enough candles'); process.exit(1); }
  const T = runTrack(c); const r = T[T.length - 1]; const price = c[c.length - 1].c; const perHour = 3600 / SECS[tf];
  const H = 8; // cone: where the track points over the next H candles, with the band it has earned
  const cone = Array.from({ length: H }, (_, h) => { const n = h + 1; const mid = r.logTrack + r.vel * n; const sd = Math.sqrt(r.sdP ** 2 + (r.sdV * n) ** 2 + n * (r.sig ** 2)); return { n, mid: Math.exp(mid), lo: Math.exp(mid - sd), hi: Math.exp(mid + sd) }; });
  let since = 0; for (let k = T.length - 1; k >= 0 && T[k].mode === r.mode; k -= 1) since += 1;
  const out = { coin: u.name, tf, price, maxLev, mode: r.mode, candlesInMode: since, track: r.track, velPctPerCandle: r.vel * 100, velPctPerHour: r.vel * 100 * perHour, velMarginPctPerHourAtMax: r.vel * 100 * perHour * maxLev,
    lock: r.lock, surprise: r.surprise, prob: { hover: r.mu[0], cruise: r.mu[1], maneuver: r.mu[2] }, bandPct: r.band * 100, upper: r.track * Math.exp(1.5 * r.band), lower: r.track * Math.exp(-1.5 * r.band), cone };
  if (argv.includes('--png')) {
    const N = 140; const data = { ...out, made: new Date().toISOString().slice(0, 16) + 'Z', c: c.slice(-N), T: T.slice(-N).map((x) => ({ track: x.track, band: x.band, vel: x.vel, sdV: x.sdV, mu: x.mu, mode: x.mode, surprise: x.surprise })) };
    const dir = path.join(__dirname, 'out'); fs.mkdirSync(dir, { recursive: true }); out.file = path.join(dir, `${u.name.replace(':', '-')}-track.html`);
    fs.writeFileSync(out.file, fs.readFileSync(path.join(__dirname, 'track.template.html'), 'utf8').replace('/*DATA*/null', JSON.stringify(data)).replace('/*LOGO*/', fs.readFileSync(path.join(__dirname, 'brand', 'gemach-lion.svg'), 'utf8')));
  }
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); return; }
  const mC = r.mode === 'UP' ? C.go : r.mode === 'DOWN' ? C.goS : r.mode === 'CHOP' ? C.chop : C.yellow;
  const label = { UP: 'LOCKED: MOVING UP', DOWN: 'LOCKED: MOVING DOWN', CHOP: 'HOVERING (CHOP)', TURNING: 'TURNING - course changing now', UNCLEAR: 'NO LOCK' }[r.mode];
  console.log(`\n${C.yellow(u.name + '  price ' + fmt(price))}   ${tf} candles   max ${maxLev}x   ${C.dim(new Date().toISOString().slice(0, 16) + 'Z')}`);
  console.log(`\n  ${mC(' ' + label + ' ')}  for ${since} candle${since === 1 ? '' : 's'}`);
  console.log(C.cyan('\nTRACK'));
  console.log(`  track (noise removed)  ${C.bold(fmt(r.track))}    price is ${(price >= r.track ? C.green : C.red)(((price / r.track - 1) * 100).toFixed(2) + '%')} from it`);
  console.log(`  velocity               ${(r.vel >= 0 ? C.green : C.red)((r.vel >= 0 ? '+' : '') + (r.vel * 100 * perHour).toFixed(2) + '% per hour')}   = ${(r.vel >= 0 ? '+' : '') + (r.vel * 100 * perHour * maxLev).toFixed(0)}% of margin per hour at ${maxLev}x`);
  console.log(`  lock                   ${C.bold(r.lock.toFixed(1))}   ${C.dim('(velocity / its uncertainty. 2+ = solid lock, under 1 = no real direction)')}`);
  console.log(`  surprise               ${(Math.abs(r.surprise) >= 2 ? C.yellow : String)(r.surprise.toFixed(1) + ' sigma')}   ${C.dim('(how far the last close landed from where the tracker expected. 2.5+ = a maneuver)')}`);
  console.log(`  model vote             hover ${(r.mu[0] * 100).toFixed(0)}%   cruise ${(r.mu[1] * 100).toFixed(0)}%   maneuver ${(r.mu[2] * 100).toFixed(0)}%`);
  console.log(C.cyan('\nCHOP BAND') + C.dim('  (1.5 sigma round the track: where a hovering price normally turns back)'));
  console.log(`  upper ${C.red(fmt(out.upper))}   track ${fmt(r.track)}   lower ${C.green(fmt(out.lower))}   half-width ${(1.5 * r.band * 100).toFixed(2)}% = ${(1.5 * r.band * 100 * maxLev).toFixed(0)}% of margin at ${maxLev}x`);
  console.log(C.cyan('\nCONE') + C.dim('  (where the current course points, with the spread it has earned)'));
  for (const q of cone.filter((x) => [1, 2, 4, 8].includes(x.n))) console.log(`  +${pad(q.n, 2)} candles  ${pad(fmt(q.lo), 10)}  ..  ${C.bold(pad(fmt(q.mid), 10))}  ..  ${pad(fmt(q.hi), 10)}`);
  console.log(C.dim(`\nThe tracker measures motion; it does not predict. Check it against history: node track.js ${u.name} --backtest\n`));
}
const BASKET = ['BTC', 'ETH', 'SOL', 'HYPE', 'ZEC', 'xyz:NVDA', 'xyz:SNDK', 'xyz:GOLD'];
const PAIRS = [['ETH', 'BTC'], ['SOL', 'ETH'], ['SOL', 'BTC'], ['xyz:NVDA', 'io:NVDA'], ['xyz:SNDK', 'xyz:MU'], ['xyz:GOLD', 'xyz:SILVER']];
async function pairCmd() {
  LEGS = 2; const i = argv.indexOf('--pair'); const named = [argv[i + 1], argv[i + 2]].filter((x) => x && !x.startsWith('--')).map(normCoin);
  return backtestCmd(named.length === 2 ? [named] : PAIRS, flag('tf', null) ? [flag('tf')] : ['15m', '1h']);
}
if (require.main === module) (argv.includes('--pair') || argv.includes('--pairs') ? pairCmd() : argv.includes('--backtest-all') ? backtestCmd(BASKET, flag('tf', null) ? [flag('tf')] : ['5m', '15m', '1h']) : one()).catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
module.exports = { runTrack, backtest, stats, candles };
