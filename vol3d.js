#!/usr/bin/env node
/**
 * VOL3D — a 3-D terrain of where the volume traded, for picking strike points. Read-only.
 *
 *   node vol3d.js BTC                  # last 24h from 5m candles -> out/BTC-3d.html
 *   node vol3d.js xyz:ANT --hours 48
 *
 * Floor = time (left to right) x price (front to back). Height = volume traded at that price in
 * that half hour. Mountains/ridges = prices the market fought over (walls). Valleys = thin air,
 * where price travels fast. The white line is the price path walking over the terrain.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function hl(body) {
  for (let k = 0; ; k += 1) { // the public API rate-limits bursts: retry a null/429 a few times
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j != null || k >= 4) return j;
    await new Promise((res) => setTimeout(res, 700 * (k + 1)));
  }
}
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };

async function main() {
  let coin = argv.find((a, k) => !a.startsWith('--') && !(k > 0 && argv[k - 1].startsWith('--')));
  if (!coin) { console.log('usage: vol3d.js <COIN> [--hours 24]'); process.exit(1); }
  const ci = coin.indexOf(':');
  coin = ci === -1 ? coin.toUpperCase() : coin.slice(0, ci).toLowerCase() + ':' + coin.slice(ci + 1).toUpperCase();
  const hours = Number(flag('hours', 24));
  const PB = 44; // price bins
  const TB = 48; // time buckets
  const now = Date.now();
  const tf = hours <= 30 ? '5m' : hours <= 90 ? '15m' : '1h';
  const raw = await hl({ type: 'candleSnapshot', req: { coin, interval: tf, startTime: now - hours * 3600e3, endTime: now } });
  if (!Array.isArray(raw) || raw.length < 20) { console.log(`no candles for ${coin}`); process.exit(1); }
  const c = raw.map((x) => ({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v * +x.c }));
  const lo = Math.min(...c.map((x) => x.l)); const hi = Math.max(...c.map((x) => x.h));
  const padPx = (hi - lo) * 0.04; const pLo = lo - padPx; const pHi = hi + padPx; const step = (pHi - pLo) / PB;
  const t0 = c[0].t; const t1 = c[c.length - 1].t + 1; const tStep = (t1 - t0) / TB;
  const vol = Array.from({ length: TB }, () => new Array(PB).fill(0));
  const net = Array.from({ length: TB }, () => new Array(PB).fill(0)); // + up-candle volume, - down-candle volume
  const pathPts = Array.from({ length: TB }, () => null);
  for (const x of c) {
    const ti = Math.min(TB - 1, Math.floor((x.t - t0) / tStep));
    const a = Math.max(0, Math.floor((x.l - pLo) / step)); const b = Math.min(PB - 1, Math.floor((x.h - pLo) / step));
    const share = x.v / (b - a + 1);
    for (let p = a; p <= b; p += 1) { vol[ti][p] += share; net[ti][p] += x.c >= x.o ? share : -share; }
    pathPts[ti] = { close: x.c, high: Math.max(pathPts[ti]?.high ?? x.h, x.h), low: Math.min(pathPts[ti]?.low ?? x.l, x.l) };
  }
  for (let k = 1; k < TB; k += 1) if (!pathPts[k]) pathPts[k] = pathPts[k - 1];
  const price = c[c.length - 1].c;
  const prices = Array.from({ length: PB }, (_, p) => pLo + (p + 0.5) * step);
  // volume profile across the whole window -> walls (peaks) and air pockets (thin gaps between walls)
  const prof = prices.map((_, p) => vol.reduce((a, row) => a + row[p], 0));
  const sm = prof.map((v, p) => (prof[p - 1] ?? v) * 0.25 + v * 0.5 + (prof[p + 1] ?? v) * 0.25);
  const mean = sm.reduce((a, b) => a + b, 0) / PB;
  const walls = []; const air = [];
  for (let p = 1; p < PB - 1; p += 1) {
    if (sm[p] > sm[p - 1] && sm[p] >= sm[p + 1] && sm[p] > mean * 1.1) walls.push({ px: prices[p], vol: sm[p] });
    if (sm[p] < sm[p - 1] && sm[p] <= sm[p + 1] && sm[p] < mean * 0.7) air.push({ px: prices[p], vol: sm[p] });
  }
  let lv = null;
  try { lv = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'levels.js'), coin, '--json'], { encoding: 'utf8' })); } catch { /* zones are optional */ }
  const maxLev = lv?.maxLev || 10; const halfLev = lv?.halfLev || 5;
  const tag = (px) => ({ px, awayPct: (px / price - 1) * 100, slHalf: Math.abs(px / price - 1) * 100 * halfLev, slMax: Math.abs(px / price - 1) * 100 * maxLev });
  // realized volatility by hour of day (UTC) from the same candles
  const byHour = Array.from({ length: 24 }, () => ({ s: 0, n: 0 }));
  for (const x of c) { const h = new Date(x.t).getUTCHours(); byHour[h].s += (x.h - x.l) / x.c * 100; byHour[h].n += 1; }
  const data = {
    coin, price, hours, tf, made: new Date().toISOString().slice(0, 16) + 'Z', maxLev, halfLev,
    prices, vol, net, path: pathPts, tStart: t0, tEnd: t1,
    walls: walls.sort((a, b) => b.vol - a.vol).slice(0, 7).map((w) => ({ ...tag(w.px), vol: w.vol })),
    air: air.sort((a, b) => a.vol - b.vol).slice(0, 5).map((w) => ({ ...tag(w.px), vol: w.vol })),
    zonesAbove: (lv?.above || []).slice(0, 4), zonesBelow: (lv?.below || []).slice(0, 4),
    frames: (lv?.frames || []).map((f) => ({ tf: f.tf, atrPct: f.atrPct })),
    byHour: byHour.map((h) => (h.n ? h.s / h.n : 0)), totalVol: c.reduce((a, x) => a + x.v, 0),
    rangePct: (hi / lo - 1) * 100, hi, lo,
  };
  const outDir = path.join(__dirname, 'out'); fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${coin.replace(':', '-')}-3d.html`);
  fs.writeFileSync(file, fs.readFileSync(path.join(__dirname, 'vol3d.template.html'), 'utf8').replace('/*DATA*/null', JSON.stringify(data)).replace('/*LOGO*/', fs.readFileSync(path.join(__dirname, 'brand', 'gemach-lion.svg'), 'utf8')));
  console.log(JSON.stringify({ ok: true, file, coin, price, hi, lo, rangePct: +data.rangePct.toFixed(2), walls: data.walls.map((w) => +w.px.toPrecision(5)), air: data.air.map((w) => +w.px.toPrecision(5)) }, null, 1));
}
main().catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
