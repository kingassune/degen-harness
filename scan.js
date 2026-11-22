#!/usr/bin/env node
/**
 * SCAN — where is the action. Ranks every HyperLiquid perp (all venues) by how hard it is moving.
 * Read-only.   node scan.js [--top 15] [--no-color] [--json]
 * heat = last-hour range as a multiple of that market's normal hourly range (2.0 = twice as wild as usual).
 */
'use strict';
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const COLOR = !argv.includes('--no-color') && !JSON_OUT && !process.env.NO_COLOR;
const paint = (c) => (t) => (COLOR ? `\x1b[${c}m${t}\x1b[0m` : String(t));
const C = { red: paint('1;31'), green: paint('1;32'), yellow: paint('1;33'), cyan: paint('1;36'), dim: paint('2'), alarm: paint('1;37;41') };
const pad = (s, n) => String(s).padStart(n);
const fmt = (v) => (v >= 1000 ? v.toFixed(0) : v >= 10 ? v.toFixed(2) : v >= 0.1 ? v.toFixed(4) : v.toPrecision(4));
async function hl(body) {
  for (let k = 0; ; k += 1) {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j != null || k >= 4) return j;
    await new Promise((res) => setTimeout(res, 700 * (k + 1)));
  }
}
async function main() {
  const ti = argv.indexOf('--top'); const top = ti === -1 ? 15 : Number(argv[ti + 1]);
  const dexes = ['', ...(await hl({ type: 'perpDexs' })).filter(Boolean).map((d) => d.name)];
  const all = [];
  for (const dex of dexes) {
    const res = await hl({ type: 'metaAndAssetCtxs', dex }); if (!res) continue;
    res[0].universe.forEach((u, k) => {
      const x = res[1][k]; if (u.isDelisted || !x || !Number(x.dayNtlVlm)) return;
      const px = Number(x.markPx);
      all.push({ coin: u.name, px, maxLev: u.maxLeverage, vol: Number(x.dayNtlVlm), oi: Number(x.openInterest) * px, chg: (px / Number(x.prevDayPx) - 1) * 100, fundApr: Number(x.funding) * 876000 });
    });
  }
  const breadth = { n: all.length, down: all.filter((a) => a.chg < 0).length, median: [...all].sort((a, b) => a.chg - b.chg)[Math.floor(all.length / 2)].chg };
  const liquid = all.sort((a, b) => b.vol - a.vol).slice(0, Math.max(top * 2, 30));
  const now = Date.now();
  for (const m of liquid) {
    const c = await hl({ type: 'candleSnapshot', req: { coin: m.coin, interval: '1h', startTime: now - 49 * 3600e3, endTime: now } });
    if (!Array.isArray(c) || c.length < 6) { m.heat = 0; continue; }
    const rng = c.map((x) => (Number(x.h) - Number(x.l)) / Number(x.c) * 100);
    const last = c[c.length - 1]; const prev = c[c.length - 2];
    m.hr = Math.max(rng[rng.length - 1], rng[rng.length - 2]);          // widest of the forming and last closed hour
    m.norm = rng.slice(0, -2).sort((a, b) => a - b)[Math.floor((rng.length - 2) / 2)] || 0.0001; // median hourly range
    m.heat = m.hr / m.norm;
    m.hi = Math.max(...c.slice(-24).map((x) => Number(x.h))); m.lo = Math.min(...c.slice(-24).map((x) => Number(x.l)));
    m.pos = (m.px - m.lo) / (m.hi - m.lo || 1) * 100;                   // 0 = at the 24h low, 100 = at the 24h high
    m.h1 = (Number(last.c) / Number(prev.o) - 1) * 100;                 // move over the last ~2 hours
  }
  const ranked = liquid.filter((m) => m.heat).sort((a, b) => b.heat * Math.log10(b.vol) - a.heat * Math.log10(a.vol)).slice(0, top);
  if (JSON_OUT) { console.log(JSON.stringify({ breadth, ranked }, null, 1)); return; }
  console.log(`\n${C.cyan('MARKET')}  ${breadth.n} live perps   ${C.red(breadth.down + ' down')} / ${C.green(breadth.n - breadth.down + ' up')}   median 24h ${(breadth.median >= 0 ? C.green : C.red)(breadth.median.toFixed(1) + '%')}   ${C.dim(new Date().toISOString().slice(0, 16) + 'Z')}`);
  console.log(C.dim(`\n${pad('market', 14)} ${pad('price', 10)} ${pad('24h', 8)} ${pad('~2h', 7)} ${pad('heat', 6)} ${pad('hr range', 9)} ${pad('in 24h range', 13)} ${pad('vol 24h', 10)} ${pad('lev', 4)} ${pad('funding/yr', 11)}`));
  for (const m of ranked) {
    const heatC = m.heat >= 2 ? C.alarm : m.heat >= 1.3 ? C.yellow : C.dim;
    const where = m.pos <= 15 ? C.red('AT LOW') : m.pos >= 85 ? C.green('AT HIGH') : `${m.pos.toFixed(0)}%`;
    console.log(`${C.yellow(pad(m.coin, 14))} ${pad(fmt(m.px), 10)} ${(m.chg >= 0 ? C.green : C.red)(pad(m.chg.toFixed(1) + '%', 8))} ${(m.h1 >= 0 ? C.green : C.red)(pad(m.h1.toFixed(1) + '%', 7))} ${heatC(pad(m.heat.toFixed(1) + 'x', 6))} ${pad(m.hr.toFixed(2) + '%', 9)} ${pad(where, COLOR && (m.pos <= 15 || m.pos >= 85) ? 24 : 13)} ${pad('$' + (m.vol / 1e6).toFixed(0) + 'M', 10)} ${pad(m.maxLev + 'x', 4)} ${(Math.abs(m.fundApr) >= 30 ? C.yellow : C.dim)(pad(m.fundApr.toFixed(0) + '%', 11))}`);
  }
  console.log(C.dim('\nheat = the last hour\'s range against that market\'s normal hourly range. Next: node levels.js <market>  or  node vol3d.js <market>\n'));
}
main().catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
