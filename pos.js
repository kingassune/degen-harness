#!/usr/bin/env node
/**
 * POS — what am I in and what am I up. Read-only, public data, no wallet file or keys.
 *
 *   node pos.js                 # positions, P&L, stops/targets, account
 *   node pos.js --watch 10      # refresh every 10 seconds
 *   node pos.js --json | --no-color
 *
 * Address: DEGEN_ADDRESS env, else "address" in ./config.json (the MANAGED HyperLiquid address).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const COLOR = !argv.includes('--no-color') && !JSON_OUT && !process.env.NO_COLOR;
const paint = (code) => (t) => (COLOR ? `\x1b[${code}m${t}\x1b[0m` : String(t));
const C = { red: paint('1;31'), green: paint('1;32'), yellow: paint('1;33'), cyan: paint('1;36'), dim: paint('2'), bold: paint('1'), alarm: paint('1;37;41') };
const pnlC = (v) => (v > 0 ? C.green : v < 0 ? C.red : C.dim);
const money = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
const pc = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const fmt = (v) => (v >= 1000 ? v.toFixed(0) : v >= 10 ? v.toFixed(2) : v >= 0.1 ? v.toFixed(4) : v.toPrecision(4));

function address() {
  if (process.env.DEGEN_ADDRESS) return process.env.DEGEN_ADDRESS;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).address; } catch { return null; }
}
async function hl(body) {
  const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function snapshot(user) {
  const dexes = ['', ...(await hl({ type: 'perpDexs' })).filter(Boolean).map((d) => d.name)];
  const spot = await hl({ type: 'spotClearinghouseState', user });
  const usdc = (spot.balances || []).find((b) => b.coin === 'USDC') || { total: 0, hold: 0 };
  const states = await Promise.all(dexes.map((dex) => hl({ type: 'clearinghouseState', user, dex }).catch(() => null)));
  const positions = []; let perpValue = 0;
  const live = [];
  states.forEach((s, k) => {
    if (!s || !s.marginSummary) return;
    perpValue += Number(s.marginSummary.accountValue);
    if (s.assetPositions.length) live.push(dexes[k]);
    for (const ap of s.assetPositions) positions.push({ dex: dexes[k], raw: ap.position });
  });
  // marks and orders only for the dexes that actually hold something
  const marks = {}; const orders = [];
  for (const dex of live) {
    const [meta, ctxs] = await hl({ type: 'metaAndAssetCtxs', dex });
    meta.universe.forEach((u, k) => { marks[u.name] = { mark: Number(ctxs[k].markPx), funding: Number(ctxs[k].funding) }; });
  }
  for (const dex of dexes) { // every venue, so resting limit entries show even with no position open
    const oo = await hl({ type: 'frontendOpenOrders', user, dex });
    const add = (o, parent) => { orders.push({ ...o, parentOid: parent ? parent.oid : null }); for (const ch of o.children || []) add(ch, o); };
    for (const o of Array.isArray(oo) ? oo : []) add(o, null);
  }
  const resting = orders.filter((o) => !o.reduceOnly && !o.isTrigger).map((o) => {
    const px = Number(o.limitPx); const kids = orders.filter((k) => k.parentOid === o.oid);
    const st = kids.find((k) => /stop/i.test(k.orderType)); const tg = kids.find((k) => /take/i.test(k.orderType));
    return { oid: o.oid, coin: o.coin, side: o.side === 'B' ? 'LONG' : 'SHORT', px, size: Number(o.sz), notional: px * Number(o.sz), mark: (marks[o.coin] || {}).mark || null,
      stop: st ? Number(st.triggerPx) : null, target: tg ? Number(tg.triggerPx) : null, riskUsd: st ? Math.abs(Number(st.triggerPx) - px) * Number(o.sz) : null };
  });
  for (const r of resting) if (!r.mark) { const b = await hl({ type: 'l2Book', coin: r.coin }); if (b && b.levels) r.mark = (Number(b.levels[0][0].px) + Number(b.levels[1][0].px)) / 2; }
  const out = positions.map(({ raw: p }) => {
    const szi = Number(p.szi); const entry = Number(p.entryPx); const side = szi > 0 ? 'LONG' : 'SHORT';
    const mark = (marks[p.coin] || {}).mark || Number(p.positionValue) / Math.abs(szi);
    const margin = Number(p.marginUsed); const upnl = Number(p.unrealizedPnl); const lev = p.leverage.value;
    const liq = p.liquidationPx ? Number(p.liquidationPx) : null;
    const mine = orders.filter((o) => o.coin === p.coin && o.reduceOnly && o.parentOid == null);
    const leg = (o) => {
      if (!o) return null;
      const px = Number(o.triggerPx) > 0 ? Number(o.triggerPx) : Number(o.limitPx);
      const pnl = (px - entry) * szi; // dollars if it fills there
      return { px, awayPct: (px / mark - 1) * 100, pnl, marginPct: margin ? pnl / (Math.abs(szi) * entry / lev) * 100 : 0 };
    };
    return {
      coin: p.coin, side, lev, size: Math.abs(szi), entry, mark, notional: Math.abs(szi) * mark, margin,
      upnl, roePct: Number(p.returnOnEquity) * 100, movePct: (mark / entry - 1) * 100 * Math.sign(szi),
      liq, liqAwayPct: liq ? Math.abs(liq / mark - 1) * 100 : null,
      stop: leg(mine.find((o) => /stop/i.test(o.orderType))), target: leg(mine.find((o) => /take/i.test(o.orderType)) || mine.find((o) => !o.isTrigger && (Number(o.limitPx) - entry) * szi > 0)),
      fundingPaid: Number(p.cumFunding?.sinceOpen || 0), fundingAprPct: ((marks[p.coin] || {}).funding || 0) * 876000,
    };
  });
  const since = Date.now() - 86400000;
  const fills = (await hl({ type: 'userFillsByTime', user, startTime: since })) || [];
  const realized = fills.reduce((a, f) => a + Number(f.closedPnl || 0) - Number(f.fee || 0), 0);
  const free = Number(usdc.total) - Number(usdc.hold);
  return {
    t: new Date().toISOString(), equity: free + perpValue, free, inTrades: out.reduce((a, p) => a + p.margin, 0),
    upnl: out.reduce((a, p) => a + p.upnl, 0), realized24h: realized, trades24h: fills.filter((f) => /Close/.test(f.dir)).length,
    atRisk: out.reduce((a, p) => a + (p.stop ? Math.max(0, -p.stop.pnl) : p.margin), 0), positions: out, resting,
  };
}

function render(s) {
  const L = [];
  L.push(`\n${C.cyan('ACCOUNT')}  equity ${C.yellow('$' + s.equity.toFixed(2))}   free $${s.free.toFixed(2)}   in trades $${s.inTrades.toFixed(2)}   ${C.dim(s.t.slice(0, 19) + 'Z')}`);
  L.push(`  open P&L ${pnlC(s.upnl)(money(s.upnl))}   last 24h closed ${pnlC(s.realized24h)(money(s.realized24h))} after fees (${s.trades24h} closes)   at risk if every stop hits ${C.red('$' + s.atRisk.toFixed(2))}`);
  for (const r of s.resting || []) {
    const away = r.mark ? (r.px / r.mark - 1) * 100 : null;
    L.push(`\n${C.yellow('WAITING ' + r.side + ' ' + r.coin)}  limit ${C.bold(fmt(r.px))}${away != null ? '   ' + Math.abs(away).toFixed(2) + '% ' + (away < 0 ? 'below' : 'above') + ' now ' + fmt(r.mark) : ''}   size ${r.size} ($${r.notional.toFixed(0)})   ${C.dim('order ' + r.oid)}`);
    L.push(`  ${r.stop ? C.red('stop   ') + fmt(r.stop) : C.alarm(' NO STOP ATTACHED ')}   ${r.target ? C.green('target ') + fmt(r.target) : C.dim('no target')}   ${r.riskUsd != null ? 'risk if filled then stopped ' + C.red('$' + r.riskUsd.toFixed(2)) : ''}`);
  }
  if (!s.positions.length) { L.push(`\n  ${C.dim('FLAT — no open positions.')}${(s.resting || []).length ? '' : C.dim(' No resting orders.')}\n`); return L.join('\n'); }
  for (const p of s.positions) {
    const sideC = p.side === 'LONG' ? C.green : C.red;
    L.push(`\n${sideC(p.side + ' ' + p.coin)} ${C.bold(p.lev + 'x')}   size ${p.size} ($${p.notional.toFixed(0)})   margin $${p.margin.toFixed(2)}`);
    L.push(`  entry ${fmt(p.entry)}  ->  now ${C.yellow(fmt(p.mark))}   price ${pc(p.movePct)} your way   ${C.bold('P&L')} ${pnlC(p.upnl)(money(p.upnl) + '  (' + pc(p.roePct) + ' on margin)')}`);
    if (p.stop) L.push(`  ${C.red('stop  ')} ${fmt(p.stop.px)}   ${Math.abs(p.stop.awayPct).toFixed(2)}% away   ${pnlC(p.stop.pnl)(money(p.stop.pnl) + ' (' + pc(p.stop.marginPct) + ')')}`);
    else L.push(`  ${C.alarm(' NO STOP ON THIS POSITION ')}`);
    if (p.target) L.push(`  ${C.green('target')} ${fmt(p.target.px)}   ${Math.abs(p.target.awayPct).toFixed(2)}% away   ${pnlC(p.target.pnl)(money(p.target.pnl) + ' (' + pc(p.target.marginPct) + ')')}`);
    const liqTxt = p.liq ? `${fmt(p.liq)}   ${p.liqAwayPct.toFixed(2)}% away` : 'none (covered by account)';
    L.push(`  ${p.liqAwayPct != null && p.liqAwayPct < 1 ? C.alarm(' LIQUIDATION ') : C.dim('liquid.')} ${liqTxt}   ${C.dim('funding so far ' + money(-p.fundingPaid) + ', rate ' + p.fundingAprPct.toFixed(0) + '%/yr')}`);
  }
  L.push('');
  return L.join('\n');
}

async function main() {
  const user = address();
  if (!user) { console.log('no address: set DEGEN_ADDRESS or put {"address":"0x..."} in config.json'); process.exit(1); }
  const wi = argv.indexOf('--watch');
  if (wi === -1) {
    const s = await snapshot(user);
    console.log(JSON_OUT ? JSON.stringify(s, null, 1) : render(s));
    return;
  }
  const every = Math.max(3, Number(argv[wi + 1]) || 10) * 1000;
  for (;;) {
    const s = await snapshot(user).catch((e) => ({ err: String(e.message || e) }));
    process.stdout.write('\x1b[2J\x1b[H' + (s.err ? `read failed: ${s.err}\n` : render(s)) + C.dim(`refreshing every ${every / 1000}s — Ctrl+C to stop\n`));
    await new Promise((r) => setTimeout(r, every));
  }
}
main().catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
