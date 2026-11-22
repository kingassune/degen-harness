#!/usr/bin/env node
/**
 * STATS — is the system working? Your real closed trades against the break-even line. Read-only.
 *
 *   node stats.js                 # last 30 days
 *   node stats.js --days 7
 *   node stats.js --all           # include trades the journal marks as tests
 *   node stats.js --json | --no-color
 *
 * A trade = one round trip in a market, from flat back to flat, built from HyperLiquid fills. Result = closed P&L minus fees.
 * When the journal has the plan for a trade, the result is also shown in R (multiples of the dollars risked).
 * Break-even win rate = average loss / (average loss + average win): the share of winners you need at YOUR average win and loss.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const JSON_OUT = argv.includes('--json');
const COLOR = !argv.includes('--no-color') && !JSON_OUT && !process.env.NO_COLOR;
const paint = (c) => (t) => (COLOR ? `\x1b[${c}m${t}\x1b[0m` : String(t));
const C = { red: paint('1;31'), green: paint('1;32'), yellow: paint('1;33'), cyan: paint('1;36'), dim: paint('2'), bold: paint('1'), alarm: paint('1;37;41') };
const pad = (s, n) => String(s).padStart(n); const padE = (s, n) => String(s).padEnd(n);
const money = (v) => (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2);
const col = (v) => (v >= 0 ? C.green : C.red);

async function hl(body) {
  for (let k = 0; ; k += 1) {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j != null || k >= 5) return j;
    await new Promise((res) => setTimeout(res, 900 * (k + 1)));
  }
}
function address() {
  if (process.env.DEGEN_ADDRESS) return process.env.DEGEN_ADDRESS;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).address; } catch { return null; }
}
function journal() {
  try { return fs.readFileSync(path.join(__dirname, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((j) => j && j.plan); } catch { return []; }
}
/** Group fills into round trips per market (flat -> flat). */
function trips(fills) {
  const open = new Map(); const out = [];
  for (const f of [...fills].sort((a, b) => a.time - b.time)) {
    const sz = Number(f.sz) * (f.side === 'B' ? 1 : -1); const start = Number(f.startPosition); const end = start + sz;
    let t = open.get(f.coin);
    if (!t) { t = { coin: f.coin, t0: f.time, side: sz > 0 ? 'long' : 'short', entryNotional: 0, entrySz: 0, pnl: 0, fees: 0, fills: 0, maxSz: 0 }; open.set(f.coin, t); }
    if (Math.abs(end) > Math.abs(start)) { t.entryNotional += Number(f.px) * Math.abs(sz); t.entrySz += Math.abs(sz); }
    t.pnl += Number(f.closedPnl || 0); t.fees += Number(f.fee || 0); t.fills += 1; t.maxSz = Math.max(t.maxSz, Math.abs(end), Math.abs(start)); t.t1 = f.time;
    if (Math.abs(end) < 1e-12) { t.net = t.pnl - t.fees; t.notional = t.entryNotional; t.entry = t.entrySz ? t.entryNotional / t.entrySz : 0; out.push(t); open.delete(f.coin); }
  }
  return { closed: out, stillOpen: [...open.values()] };
}
async function main() {
  const user = address(); if (!user) { console.log('no address: set DEGEN_ADDRESS or config.json {"address": "0x..."}'); process.exit(1); }
  const days = Number(flag('days', 30)); const since = Date.now() - days * 86400e3;
  const fills = (await hl({ type: 'userFillsByTime', user, startTime: since })) || [];
  const { closed, stillOpen } = trips(fills); const J = journal();
  for (const t of closed) { // match the journal plan placed shortly before the first fill
    const j = J.filter((x) => x.plan.coin === t.coin && new Date(x.t).getTime() <= t.t0 + 5000 && t.t0 - new Date(x.t).getTime() < 6 * 3600e3).pop();
    if (j) { t.risk = j.plan.risk; t.R = j.plan.risk ? t.net / j.plan.risk : null; t.lev = j.plan.lev; t.thesis = j.thesis || ''; t.test = /live test/i.test(j.thesis || ''); }
  }
  const all = argv.includes('--all'); const used = closed.filter((t) => all || !t.test); const tests = closed.length - used.length;
  const wins = used.filter((t) => t.net > 0); const losses = used.filter((t) => t.net <= 0);
  const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
  const avgWin = wins.length ? sum(wins, (t) => t.net) / wins.length : 0; const avgLoss = losses.length ? -sum(losses, (t) => t.net) / losses.length : 0;
  const withR = used.filter((t) => t.R != null);
  const s = {
    days, trades: used.length, testsLeftOut: tests, wins: wins.length, winPct: used.length ? wins.length / used.length * 100 : 0,
    avgWin, avgLoss, payoff: avgLoss ? avgWin / avgLoss : null, breakevenWinPct: avgWin + avgLoss ? avgLoss / (avgLoss + avgWin) * 100 : null,
    net: sum(used, (t) => t.net), gross: sum(used, (t) => t.pnl), fees: sum(used, (t) => t.fees), perTrade: used.length ? sum(used, (t) => t.net) / used.length : 0,
    avgR: withR.length ? sum(withR, (t) => t.R) / withR.length : null, tradesWithPlan: withR.length, volume: sum(used, (t) => t.notional) * 2,
  };
  const pf = await hl({ type: 'portfolio', user }); const growth = {};
  for (const [period, v] of Array.isArray(pf) ? pf : []) {
    if (!['day', 'week', 'month', 'allTime'].includes(period)) continue;
    const av = v.accountValueHistory || []; const pn = v.pnlHistory || []; if (!av.length || !pn.length) continue;
    const pnl = Number(pn[pn.length - 1][1]) - Number(pn[0][1]); const start = Number(av[0][1]);
    growth[period] = { pnl, startValue: start, pct: start > 0 ? pnl / start * 100 : null, nowValue: Number(av[av.length - 1][1]) };
  }
  if (JSON_OUT) { console.log(JSON.stringify({ stats: s, growth, trades: used, stillOpen }, null, 1)); return; }
  console.log(`\n${C.cyan('SCORECARD')}  last ${days} days   ${C.dim(new Date().toISOString().slice(0, 16) + 'Z')}`);
  if (!used.length) { console.log(`\n  ${C.dim('No closed trades yet' + (tests ? ` (${tests} test trade${tests === 1 ? '' : 's'} left out; --all to include)` : '') + '.')}\n`); }
  else {
    const be = s.breakevenWinPct; const ahead = be != null ? s.winPct - be : null;
    console.log(`\n  trades ${C.bold(s.trades)}   net ${col(s.net)(money(s.net))}   ${C.dim('= ' + money(s.gross) + ' before fees, $' + s.fees.toFixed(2) + ' in fees')}   per trade ${col(s.perTrade)(money(s.perTrade))}`);
    console.log(`  win rate ${C.bold(s.winPct.toFixed(0) + '%')} (${s.wins} of ${s.trades})   average win ${C.green('$' + avgWin.toFixed(2))}   average loss ${C.red('$' + avgLoss.toFixed(2))}${s.payoff != null ? '   win/loss size ' + s.payoff.toFixed(2) + 'x' : ''}`);
    if (be != null) console.log(`  break-even win rate at those sizes ${C.bold(be.toFixed(0) + '%')}   ->  you are ${ahead >= 0 ? C.green(ahead.toFixed(0) + ' points above it') : C.red(Math.abs(ahead).toFixed(0) + ' points below it')}`);
    if (s.avgR != null) console.log(`  average result ${col(s.avgR)((s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2) + ' R')} on the ${s.tradesWithPlan} trade${s.tradesWithPlan === 1 ? '' : 's'} with a journal plan   ${C.dim('(R = multiples of the dollars risked)')}`);
    if (s.trades < 30) console.log(`  ${C.yellow('Only ' + s.trades + ' trade' + (s.trades === 1 ? '' : 's') + ': too few to tell skill from luck. Around 30+ starts to mean something.')}`);
    if (tests) console.log(C.dim(`  ${tests} test trade${tests === 1 ? '' : 's'} left out (--all to include)`));
    console.log(C.dim(`\n${padE('closed (UTC)', 17)} ${padE('market', 12)} ${padE('side', 6)} ${pad('size $', 8)} ${pad('before fees', 12)} ${pad('fees', 7)} ${pad('net', 9)} ${pad('R', 6)}  note`));
    for (const t of used.slice(-25)) console.log(`${padE(new Date(t.t1).toISOString().slice(5, 16).replace('T', ' '), 17)} ${C.yellow(padE(t.coin, 12))} ${padE(t.side, 6)} ${pad(t.notional.toFixed(0), 8)} ${pad(money(t.pnl), 12)} ${pad(t.fees.toFixed(2), 7)} ${col(t.net)(pad(money(t.net), 9))} ${pad(t.R != null ? t.R.toFixed(2) : '-', 6)}  ${C.dim((t.thesis || '').slice(0, 40))}`);
  }
  if (Object.keys(growth).length) {
    console.log(C.cyan('\nACCOUNT GROWTH') + C.dim('  (trading P&L over the period against the value at its start; deposits are not counted as growth)'));
    for (const k of ['day', 'week', 'month', 'allTime']) { const g = growth[k]; if (!g) continue; console.log(`  ${padE(k === 'allTime' ? 'all time' : k, 9)} ${col(g.pnl)(pad(money(g.pnl), 10))}  ${g.pct != null ? col(g.pct)(pad((g.pct >= 0 ? '+' : '') + g.pct.toFixed(1) + '%', 8)) : pad('-', 8)}   ${C.dim('started $' + g.startValue.toFixed(2))}`); }
  }
  if (stillOpen.length) console.log(C.dim(`\nstill open, not counted: ${stillOpen.map((t) => t.coin).join(', ')}`));
  console.log('');
}
main().catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
