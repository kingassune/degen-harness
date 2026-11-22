#!/usr/bin/env node
/**
 * MOM — momentum hunter. Candlesticks + how hard and how clean price is moving, in leverage terms. Read-only.
 *
 *   node mom.js BTC                 # momentum board (5m/15m/1h/4h) + candle chart in the terminal
 *   node mom.js xyz:ANT --tf 5m     # chart a different timeframe (default 15m)
 *   node mom.js BTC --sl 20         # your stop, as % of margin (default 20)
 *   node mom.js BTC --png           # also write out/<coin>-mom.html (shot.js turns it into a PNG)
 *   node mom.js --hunt [--top 12]   # rank the most traded markets by momentum, long and short
 *
 * The leg = the last 8 candles. For each timeframe:
 *   push   = net move of the leg, counted in normal-size candles (+ up, - down)
 *   clean  = net move / total distance travelled. 100% = straight line, 0% = chop   (efficiency ratio)
 *   expand = last 3 closed candles' range vs the 20 before the leg (range expansion)
 *   vol    = last 3 closed candles' volume vs the same 20
 *   dip    = the worst move against the leg while it ran -> the stop you needed to stay in
 *   paid   = what the leg paid on margin at max leverage
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const JSON_OUT = argv.includes('--json');
const COLOR = !argv.includes('--no-color') && !JSON_OUT && !process.env.NO_COLOR;
const paint = (c) => (t) => (COLOR ? `\x1b[${c}m${t}\x1b[0m` : String(t));
const C = { red: paint('31'), green: paint('32'), redB: paint('1;91'), greenB: paint('1;92'), redD: paint('2;31'), greenD: paint('2;32'), yellow: paint('1;33'), cyan: paint('1;36'), dim: paint('2'), bold: paint('1'), alarm: paint('1;37;41'), go: paint('1;30;42'), goS: paint('1;37;41') };
const pad = (s, n) => String(s).padStart(n);
const padE = (s, n) => String(s).padEnd(n);
const fmt = (v) => (v >= 1000 ? v.toFixed(0) : v >= 10 ? v.toFixed(2) : v >= 0.1 ? v.toFixed(4) : v.toPrecision(4));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const LEG = 8;
const TFS = [['5m', 300], ['15m', 900], ['1h', 3600], ['4h', 14400]];

async function hl(body) {
  for (let k = 0; ; k += 1) { // the public API rate-limits bursts: retry a null/429 a few times
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j != null || k >= 4) return j;
    await new Promise((res) => setTimeout(res, 700 * (k + 1)));
  }
}
async function candles(coin, tf, secs, n) {
  const now = Date.now();
  const raw = await hl({ type: 'candleSnapshot', req: { coin, interval: tf, startTime: now - secs * 1000 * n, endTime: now } });
  return Array.isArray(raw) ? raw.map((x) => ({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v * +x.c })) : [];
}
// is this candle an impulse candle: wider than 1.5x normal and closing in the outer 30% of its range
const impulse = (x, avgR) => { const r = x.h - x.l; if (r < avgR * 1.5 || !r) return 0; const pos = (x.c - x.l) / r; return pos >= 0.7 ? 1 : pos <= 0.3 ? -1 : 0; };

function metrics(c, maxLev) {
  if (c.length < LEG + 24) return null;
  const price = c[c.length - 1].c;
  const base = c.slice(-(LEG + 21), -(LEG + 1));           // the 20 candles before the leg = "normal"
  const avgR = mean(base.map((x) => x.h - x.l)) || price * 1e-6; const avgV = mean(base.map((x) => x.v)) || 1;
  const leg = c.slice(-LEG);
  const net = leg[LEG - 1].c - leg[0].o;
  let travel = Math.abs(leg[0].c - leg[0].o);
  for (let k = 1; k < LEG; k += 1) travel += Math.abs(leg[k].c - leg[k - 1].c);
  const dir = net >= 0 ? 1 : -1;
  const closed = c.slice(-4, -1);                          // last 3 closed candles (the forming one is partial)
  let ext = dir > 0 ? leg[0].h : leg[0].l; let dip = 0;
  for (let k = 1; k < LEG; k += 1) {
    dip = Math.max(dip, dir > 0 ? ext - leg[k].l : leg[k].h - ext);
    ext = dir > 0 ? Math.max(ext, leg[k].h) : Math.min(ext, leg[k].l);
  }
  let streak = 0; const up = (x) => x.c >= x.o;
  for (let k = c.length - 2; k >= 0 && up(c[k]) === up(c[c.length - 2]); k -= 1) streak += 1;
  const m = {
    price, dir, avgRPct: avgR / price * 100,
    push: net / avgR, clean: travel ? Math.abs(net) / travel : 0,
    expand: mean(closed.map((x) => x.h - x.l)) / avgR, vol: mean(closed.map((x) => x.v)) / avgV,
    movePct: net / leg[0].o * 100, dipPct: dip / price * 100,
    streak: (up(c[c.length - 2]) ? 1 : -1) * streak,
    stretch: (price - mean(c.slice(-20).map((x) => x.c))) / avgR,
    impulses: leg.reduce((a, x) => a + impulse(x, avgR), 0),
  };
  m.paidMax = Math.abs(m.movePct) * maxLev; m.dipMax = m.dipPct * maxLev;
  const strong = m.clean >= 0.45 && Math.abs(m.push) >= 2;
  m.state = strong && m.expand >= 1 ? (dir > 0 ? 'LONG' : 'SHORT') : strong ? (dir > 0 ? 'up, fading' : 'down, fading') : m.clean < 0.25 ? 'CHOP' : (dir > 0 ? 'weak up' : 'weak down');
  m.stretched = Math.abs(m.stretch) >= 4;
  m.score = m.clean * Math.abs(m.push) * clamp(m.expand, 0.5, 2.5) * Math.sqrt(clamp(m.vol, 0.5, 2.5));
  return m;
}
const to1h = (c) => { const g = new Map(); for (const x of c) { const k = Math.floor(x.t / 3600e3); const a = g.get(k); if (!a) g.set(k, { ...x }); else { a.h = Math.max(a.h, x.h); a.l = Math.min(a.l, x.l); a.c = x.c; a.v += x.v; } } return [...g.values()]; };
function call(by) { // one call from the 5m / 15m / 1h read
  const s = (tf) => (by[tf] ? by[tf].state : '');
  for (const d of ['LONG', 'SHORT']) {
    const opp = d === 'LONG' ? 'SHORT' : 'LONG'; const oppWeak = d === 'LONG' ? 'down' : 'up';
    if (s('15m') === d && s('1h') === d && s('5m') !== opp) return { side: d, text: `SPANK IT ${d}`, why: '15m and 1h are both pushing clean the same way' };
    if (s('15m') === d && !s('1h').includes(oppWeak) && s('1h') !== opp && s('5m') !== opp) return { side: d, text: `${d} - 15m leads`, why: '15m is pushing clean, 1h is not against it yet' };
    if (s('5m') === d && s('15m') === d) return { side: d, text: `${d} SCALP ONLY`, why: '5m and 15m push together but the 1h points the other way - quick in, quick out' };
  }
  return { side: null, text: 'NO CLEAN MOMENTUM', why: 'nothing is pushing clean on two timeframes - wait or hunt another market' };
}
const stateC = (st) => (st === 'LONG' ? C.go(' LONG  ') : st === 'SHORT' ? C.goS(' SHORT ') : st === 'CHOP' ? C.dim('CHOP') : st.includes('up') ? C.green(st) : C.red(st));

function drawChart(c, avgR, rows = 16) {
  const hi = Math.max(...c.map((x) => x.h)); const lo = Math.min(...c.map((x) => x.l)); const step = (hi - lo) / rows || 1;
  const price = c[c.length - 1].c; const maxV = Math.max(...c.map((x) => x.v)) || 1; const out = [];
  for (let r = rows - 1; r >= 0; r -= 1) {
    const a = lo + r * step; const b = a + step; let line = '';
    for (const x of c) {
      const top = Math.max(x.o, x.c); const bot = Math.min(x.o, x.c); const upC = x.c >= x.o; const imp = impulse(x, avgR); const small = (x.h - x.l) < avgR * 0.6;
      const col = upC ? (imp ? C.greenB : small ? C.greenD : C.green) : (imp ? C.redB : small ? C.redD : C.red);
      const body = top >= a && bot < b; const wick = x.h >= a && x.l < b;
      line += body ? col(imp ? '█' : '┃') : wick ? col('│') : ' ';
    }
    const here = price >= a && price < b;
    out.push(`  ${line} ${here ? C.yellow('◄ ' + fmt(price)) : C.dim(fmt(a + step / 2))}`);
  }
  const bars = '▁▂▃▄▅▆▇█';
  out.push('  ' + c.map((x) => (x.c >= x.o ? C.green : C.red)(bars[Math.min(7, Math.floor(x.v / maxV * 8))])).join('') + C.dim(' volume'));
  return out;
}

async function one() {
  let coin = argv.find((a, k) => !a.startsWith('--') && !(k > 0 && ['--tf', '--sl', '--top'].includes(argv[k - 1])));
  if (!coin) { console.log('usage: mom.js <COIN> [--tf 15m] [--sl 20] [--png]   |   mom.js --hunt [--top 12]'); process.exit(1); }
  const i = coin.indexOf(':');
  coin = i === -1 ? coin.toUpperCase() : coin.slice(0, i).toLowerCase() + ':' + coin.slice(i + 1).toUpperCase();
  const [meta] = await hl({ type: 'metaAndAssetCtxs', dex: i === -1 ? '' : coin.slice(0, i) });
  const u = meta.universe.find((x) => x.name.toLowerCase() === coin.toLowerCase());
  if (!u) { console.log(`unknown market ${coin}`); process.exit(1); }
  const maxLev = u.maxLeverage; const halfLev = Math.max(1, Math.floor(maxLev / 2)); const sl = Number(flag('sl', 20)); const chartTf = flag('tf', '15m');
  const by = {}; const raw = {};
  for (const [tf, secs] of TFS) { raw[tf] = await candles(u.name, tf, secs, 90); by[tf] = metrics(raw[tf], maxLev); }
  const price = (by['5m'] || by['15m'] || by['1h']).price; const verdict = call(by);
  const lead = by['15m'] || by['5m'];
  const ride = lead ? lead.dipPct + lead.avgRPct * 0.3 : 0;   // stop that survived the 15m leg's worst dip, plus breathing room
  const out = { coin: u.name, price, maxLev, halfLev, sl, verdict, by, ride: { pct: ride, half: ride * halfLev, max: ride * maxLev } };
  if (argv.includes('--png')) {
    const data = { ...out, made: new Date().toISOString().slice(0, 16) + 'Z', panels: ['5m', '15m', '1h'].filter((t) => by[t]).map((tf) => { const cs = raw[tf].slice(-64); const base = raw[tf].slice(-(LEG + 21), -(LEG + 1)); return { tf, c: cs, avgR: mean(base.map((x) => x.h - x.l)), m: by[tf] }; }) };
    const dir = path.join(__dirname, 'out'); fs.mkdirSync(dir, { recursive: true });
    out.file = path.join(dir, `${u.name.replace(':', '-')}-mom.html`);
    fs.writeFileSync(out.file, fs.readFileSync(path.join(__dirname, 'mom.template.html'), 'utf8').replace('/*DATA*/null', JSON.stringify(data)).replace('/*LOGO*/', fs.readFileSync(path.join(__dirname, 'brand', 'gemach-lion.svg'), 'utf8')));
  }
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); return; }

  const vC = verdict.side === 'LONG' ? C.go : verdict.side === 'SHORT' ? C.goS : C.yellow;
  console.log(`\n${C.yellow(u.name + '  price ' + fmt(price))}   max ${C.bold(maxLev + 'x')} (half ${halfLev}x)   ${C.dim(new Date().toISOString().slice(0, 16) + 'Z')}`);
  console.log(`\n  ${vC(' ' + verdict.text + ' ')}  ${C.dim(verdict.why)}`);
  console.log(C.cyan(`\nMOMENTUM BOARD`) + C.dim(`  (leg = last ${LEG} candles)`));
  console.log(C.dim(`${pad('tf', 4)}  ${padE('read', 12)} ${pad('push', 7)} ${pad('clean', 6)} ${pad('expand', 7)} ${pad('vol', 6)} ${pad('streak', 7)} ${pad('leg move', 9)} ${pad(`paid @${maxLev}x`, 11)} ${pad('worst dip', 10)} ${pad(`dip @${maxLev}x`, 10)}`));
  for (const [tf] of TFS) {
    const m = by[tf]; if (!m) continue; const dc = m.dir > 0 ? C.green : C.red; const stRaw = m.state; const st = stateC(stRaw);
    const stPad = ' '.repeat(Math.max(0, 12 - (stRaw === 'LONG' || stRaw === 'SHORT' ? 7 : stRaw.length)));
    console.log(`${pad(tf, 4)}  ${st}${stPad} ${dc(pad((m.push >= 0 ? '+' : '') + m.push.toFixed(1), 7))} ${(m.clean >= 0.45 ? C.bold : C.dim)(pad((m.clean * 100).toFixed(0) + '%', 6))} ${(m.expand >= 1.3 ? C.yellow : m.expand < 1 ? C.dim : String)(pad(m.expand.toFixed(1) + 'x', 7))} ${(m.vol >= 1.5 ? C.yellow : m.vol < 1 ? C.dim : String)(pad(m.vol.toFixed(1) + 'x', 6))} ${(m.streak > 0 ? C.green : C.red)(pad(Math.abs(m.streak) + (m.streak > 0 ? ' up' : ' dn'), 7))} ${dc(pad((m.movePct >= 0 ? '+' : '') + m.movePct.toFixed(2) + '%', 9))} ${dc(pad((m.dir > 0 ? '+' : '-') + m.paidMax.toFixed(0) + '%', 11))} ${pad(m.dipPct.toFixed(2) + '%', 10)} ${(m.dipMax <= sl ? C.greenB : C.redB)(pad(m.dipMax.toFixed(0) + '%', 10))}${m.stretched ? '  ' + C.alarm(' STRETCHED ') : ''}`);
  }
  if (lead) {
    const chk = (v) => (v <= sl ? C.greenB(v.toFixed(0) + '% ok') : C.redB(v.toFixed(0) + '% OVER'));
    console.log(C.cyan(`\nSTOP TO RIDE IT`) + `  the 15m leg dipped ${lead.dipPct.toFixed(2)}% against itself; with breathing room that is a ${C.yellow(ride.toFixed(2) + '%')} price stop`);
    console.log(`  = ${chk(ride * halfLev)} of margin at ${halfLev}x   |   ${chk(ride * maxLev)} of margin at ${maxLev}x   ${C.dim(`(your stop: ${sl}%)`)}`);
    const side = verdict.side || (lead.dir > 0 ? 'LONG' : 'SHORT');
    console.log(C.dim(`  ${side.toLowerCase()} stop at that distance: ${fmt(price * (1 + (side === 'LONG' ? -1 : 1) * ride / 100))}`));
  }
  const cs = raw[chartTf]; const mm = by[chartTf];
  if (cs && cs.length > 10 && mm) {
    console.log(C.cyan(`\nCANDLES ${chartTf}`) + C.dim(`  last ${Math.min(64, cs.length)}. Bright thick = impulse candle (1.5x normal size, closing at its end). Faint = small candle.`));
    for (const l of drawChart(cs.slice(-64), mm.avgRPct / 100 * mm.price)) console.log(l);
  }
  console.log(C.dim(`\npush = leg in normal-size candles. clean = straight-line % (under 25% is chop). expand/vol = last 3 closed candles vs normal.`));
  console.log(C.dim(`STRETCHED = 4+ normal candles from its 20-candle average: late to chase. Next: node levels.js ${u.name}\n`));
}

async function hunt() {
  const top = Number(flag('top', 12));
  const dexes = ['', ...(await hl({ type: 'perpDexs' })).filter(Boolean).map((d) => d.name)];
  const all = [];
  for (const dex of dexes) {
    const res = await hl({ type: 'metaAndAssetCtxs', dex }); if (!res) continue;
    res[0].universe.forEach((u, k) => { const x = res[1][k]; if (u.isDelisted || !x || !Number(x.dayNtlVlm)) return; all.push({ coin: u.name, maxLev: u.maxLeverage, vol: Number(x.dayNtlVlm) }); });
  }
  const liquid = all.sort((a, b) => b.vol - a.vol).slice(0, 36); const rows = [];
  for (const mk of liquid) {
    const c15 = await candles(mk.coin, '15m', 900, 150); const m15 = metrics(c15, mk.maxLev); const m1h = metrics(to1h(c15), mk.maxLev);
    if (!m15) continue;
    const v = call({ '15m': m15, '1h': m1h || undefined, '5m': undefined });
    const agree = m1h && m1h.dir === m15.dir ? 1.5 : 0.7;
    rows.push({ ...mk, m15, m1h, verdict: v, rank: m15.score * agree * (v.side ? 2 : 1) });
  }
  rows.sort((a, b) => b.rank - a.rank); const show = rows.slice(0, top);
  if (JSON_OUT) { console.log(JSON.stringify(show, null, 1)); return; }
  console.log(`\n${C.cyan('MOMENTUM HUNT')}  top ${liquid.length} markets by volume, 15m legs   ${C.dim(new Date().toISOString().slice(0, 16) + 'Z')}`);
  console.log(C.dim(`\n${pad('market', 14)} ${pad('price', 10)}  ${padE('call', 18)} ${padE('15m', 12)} ${padE('1h', 12)} ${pad('push', 6)} ${pad('clean', 6)} ${pad('expand', 7)} ${pad('vol', 6)} ${pad('2h move', 8)} ${pad('paid@max', 9)} ${pad('dip@max', 8)} ${pad('lev', 4)} ${pad('vol 24h', 9)}`));
  for (const r of show) {
    const m = r.m15; const dc = m.dir > 0 ? C.green : C.red; const vC = r.verdict.side === 'LONG' ? C.greenB : r.verdict.side === 'SHORT' ? C.redB : C.dim;
    const st = (x) => (x ? (x.state === 'LONG' ? C.greenB : x.state === 'SHORT' ? C.redB : x.state === 'CHOP' ? C.dim : x.dir > 0 ? C.green : C.red)(padE(x.state, 12)) : padE('-', 12));
    console.log(`${C.yellow(pad(r.coin, 14))} ${pad(fmt(m.price), 10)}  ${vC(padE(r.verdict.side ? r.verdict.text : 'wait', 18))} ${st(m)} ${st(r.m1h)} ${dc(pad((m.push >= 0 ? '+' : '') + m.push.toFixed(1), 6))} ${pad((m.clean * 100).toFixed(0) + '%', 6)} ${pad(m.expand.toFixed(1) + 'x', 7)} ${pad(m.vol.toFixed(1) + 'x', 6)} ${dc(pad((m.movePct >= 0 ? '+' : '') + m.movePct.toFixed(2) + '%', 8))} ${dc(pad(m.paidMax.toFixed(0) + '%', 9))} ${pad(m.dipMax.toFixed(0) + '%', 8)} ${pad(r.maxLev + 'x', 4)} ${pad('$' + (r.vol / 1e6).toFixed(0) + 'M', 9)}${m.stretched ? ' ' + C.alarm(' STRETCHED ') : ''}`);
  }
  console.log(C.dim(`\nRanked by push x clean x expansion x volume, boosted when 15m and 1h agree. Next: node mom.js <market>\n`));
}
(argv.includes('--hunt') ? hunt() : one()).catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
