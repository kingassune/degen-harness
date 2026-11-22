#!/usr/bin/env node
/**
 * DEGEN — level-based, max-leverage perp sniper on HyperLiquid via the GDEX SDK.
 *
 * Style: half-max or max leverage, tight stop at a price LEVEL, size from dollars at risk.
 *   size = risk$ / |entry - stop|      (the stop sets the size, leverage only sets the margin)
 * Every entry carries its stop and target in the same order. No naked entries.
 *
 *   node degen.js status
 *   node degen.js plan --coin BTC --side short --stop 58950 --tp 57000 --risk 20 --lev max
 *   node degen.js fire --coin BTC --side short --stop 58950 --tp 57000 --risk 20 --lev max   (LIVE)
 *   node degen.js flat [--coin BTC]
 *
 * ENTRY: market by default. --join rests the entry just inside the price for the lower fee, but it often does not fill.
 * LIMIT ENTRIES (catch it at a level instead of chasing): add --limit PX to plan / fire.
 *   node degen.js fire --coin BTC --side long --limit 60200 --sl 20 --tp 60 --margin 40 --lev half   (LIVE)
 *   The stop and target ride with the resting order and arm when it fills. Percent stops count from the limit price.
 *
 * COMPOUNDING: size from the live account instead of fixed dollars: --margin-pct 20 or --risk-pct 4 (percent of current equity).
 *   Drawdown brake: those percent sizes shrink as the account falls from its peak and stop at DEGEN_DD_FLOOR (30%).
 *   node degen.js peak [--reset]   show the peak and the brake, or restart the peak from today's equity
 *
 * FAST ADJUSTS (LIVE; add --dry to preview). They work on an open position or a resting limit order:
 *   node degen.js sl    --coin BTC --pct 10          stop = lose 10% of margin        (--to PX for a price)
 *   node degen.js sl    --coin BTC --be              stop to breakeven (entry + fees)
 *   node degen.js sl    --coin BTC --lock 30         stop that locks in +30% of margin
 *   node degen.js tp    --coin BTC --pct 150         target = +150% of margin         (--to PX for a price)
 *   node degen.js move  --coin BTC --lock 30 --tp-pct 200     stop and target in one go (--sl-to/--sl-pct/--be/--lock, --tp-to/--tp-pct)
 *   node degen.js tp    --coin BTC --off             take the target off and let it run (put one back with tp --pct / --to)
 *   node degen.js entry --coin BTC --to 60100        move a resting limit entry
 *   node degen.js orders                             everything resting, with order ids
 *   node degen.js cancel --coin BTC | --oid N --coin BTC | --all     cancel resting ENTRY orders (never a position's stop)
 *
 * Hard rails (env to change): DEGEN_MAX_RISK_USD=30 per trade, DEGEN_MAX_RISK_PCT=25 of equity
 * across open risk, stop must sit inside 70% of the distance to liquidation.
 * Env: GDEX_SKILL_DIR, GCLAW_WALLET (same as gdesk's hl_perp.js). Journal: ./journal.jsonl
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Looked for next to this folder unless the environment says otherwise, so the harness is not tied to one machine.
const HOME = path.join(__dirname, '..');
const GDEX_DIR = process.env.GDEX_SKILL_DIR || path.join(HOME, 'gdex-skill');
const WALLET_PATH = process.env.GCLAW_WALLET || path.join(HOME, 'gdex-test-wallet.json');
const JOURNAL = path.join(__dirname, 'journal.jsonl');
const MAX_RISK_USD = Number(process.env.DEGEN_MAX_RISK_USD || 30);
const MAX_RISK_PCT = Number(process.env.DEGEN_MAX_RISK_PCT || 25);
const MIN_NOTIONAL = 11;

const die = (m) => { console.log(JSON.stringify({ ok: false, error: m })); process.exit(1); };
const normCoin = (c) => { const i = c.indexOf(':'); return i === -1 ? c.toUpperCase() : c.slice(0, i).toLowerCase() + ':' + c.slice(i + 1).toUpperCase(); };
const roundSig = (v, sig = 5) => { if (!v) return 0; const f = 10 ** (sig - Math.ceil(Math.log10(Math.abs(v)))); return Math.round(v * f) / f; };

async function hl(body) {
  for (let k = 0; ; k += 1) { // the public API rate-limits bursts and answers null: retry a few times
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j != null) return j;
    if (k >= 4) throw new Error('HyperLiquid did not answer (rate limit) - try again in a few seconds');
    await new Promise((res) => setTimeout(res, 700 * (k + 1)));
  }
}
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); o[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true'; }
  return o;
}
function loadWallet() {
  const w = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const managed = w.managed?.['Arbitrum (HyperLiquid)']?.address;
  if (!w.control?.address || !w.control?.privateKey || !managed) die('wallet file incomplete');
  return { control: w.control.address, pk: w.control.privateKey, managed };
}
// GDEX allows 10 sign-ins per 15 minutes per account, so one session is saved (mode 600) and reused by every command.
// A session idles out after 30 minutes unused and expires 8 hours after login.
const SESSION = path.join(__dirname, '.session.json');
async function signed(wallet, fresh = false) {
  if (MOCK) die('DEGEN_MOCK_ACCOUNT is set: this is a test run, live actions are off');
  const { ethers } = require(path.join(GDEX_DIR, 'node_modules', 'ethers'));
  const SDK = require(path.join(GDEX_DIR, 'dist'));
  const apiKey = process.env.GDEX_API_KEY || SDK.GDEX_API_KEY_PRIMARY;
  const skill = new SDK.GdexSkill({ timeout: 60000, maxRetries: 1 });
  skill.loginWithApiKey(apiKey);
  const save = (c) => { fs.writeFileSync(SESSION, JSON.stringify(c), { mode: 0o600 }); fs.chmodSync(SESSION, 0o600); };
  if (!fresh) {
    try {
      const c = JSON.parse(fs.readFileSync(SESSION, 'utf8')); const now = Date.now();
      if (c.control === wallet.control && now - c.used < 25 * 60e3 && now - c.login < 7.5 * 3600e3) {
        skill.setBrowserSession(c.cookie); skill.setSessionSigningKey(c.key);
        save({ ...c, used: now });
        return { skill, cached: true, creds: { apiKey, walletAddress: wallet.control, sessionPrivateKey: c.key } };
      }
    } catch { /* no saved session: sign in */ }
  }
  const kp = SDK.generateGdexSessionKeyPair();
  const nonce = SDK.generateGdexNonce().toString();
  const sig = await new ethers.Wallet(wallet.pk).signMessage(SDK.buildGdexSignInMessage(wallet.control, nonce, kp.sessionKey));
  const payload = SDK.buildGdexSignInComputedData({ apiKey, userId: wallet.control, sessionKey: kp.sessionKey, nonce, signature: sig.replace(/^0x/, '') });
  await skill.signInWithComputedData({ computedData: payload.computedData, chainId: 42161 }, { sessionPrivateKey: kp.sessionPrivateKey });
  save({ control: wallet.control, key: kp.sessionPrivateKey, cookie: skill.getBrowserSession(), login: Date.now(), used: Date.now() });
  return { skill, cached: false, creds: { apiKey, walletAddress: wallet.control, sessionPrivateKey: kp.sessionPrivateKey } };
}
// Run one signed call. If a saved session was refused (expired, or replaced by a sign-in elsewhere), sign in once and retry.
// A refused call was never executed, so the retry cannot double an order.
const authFail = (r) => !!r && r.isSuccess === false && (r.code === 103 || r.status === 401 || r.status === 403 || /unauthor|session|GdexAuthError|sign.?in/i.test(String(r.error || '') + String(r.name || '')));
async function signedCall(wallet, fn) {
  const run = async (s) => fn(s.skill, s.creds).catch((e) => ({ isSuccess: false, error: String(e.message || e), name: e.name, status: e.statusCode || e.status }));
  let s = await signed(wallet); let r = await run(s);
  if (s.cached && authFail(r) && !/Too many/i.test(String(r.error))) { s = await signed(wallet, true); r = await run(s); }
  return r;
}

// Market facts for one coin: mid, max leverage, size decimals.
async function market(coin) {
  const dex = coin.includes(':') ? coin.split(':')[0] : '';
  const [meta, ctxs] = await hl({ type: 'metaAndAssetCtxs', dex });
  const i = meta.universe.findIndex((u) => u.name.toLowerCase() === coin.toLowerCase());
  if (i === -1) die(`unknown market ${coin}`);
  const book = await hl({ type: 'l2Book', coin: meta.universe[i].name });
  const bid = Number(book.levels[0][0].px); const ask = Number(book.levels[1][0].px);
  return { name: meta.universe[i].name, maxLev: meta.universe[i].maxLeverage, dp: meta.universe[i].szDecimals, bid, ask, mark: Number(ctxs[i].markPx), funding: Number(ctxs[i].funding) };
}
const MOCK = process.env.DEGEN_MOCK_ACCOUNT || ''; // test seam: a JSON file of {positions, orders}; live actions refuse to run with it
function readAddress() {
  if (process.env.DEGEN_ADDRESS) return process.env.DEGEN_ADDRESS;
  try { const a = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).address; if (a) return a; } catch { /* fall through to the wallet file */ }
  return loadWallet().managed;
}
async function account(managed) {
  const out = { positions: [], orders: [] };
  if (MOCK) { Object.assign(out, JSON.parse(fs.readFileSync(MOCK, 'utf8'))); return finish(out, 1000, 1000); }
  const spot = await hl({ type: 'spotClearinghouseState', user: managed });
  const usdc = (spot.balances || []).find((b) => b.coin === 'USDC') || { total: 0, hold: 0 };
  let perp = 0;
  for (const dex of ['', 'xyz']) {
    const s = await hl({ type: 'clearinghouseState', user: managed, dex });
    perp += Number(s.marginSummary.accountValue);
    for (const p of s.assetPositions) out.positions.push({ coin: p.position.coin, szi: Number(p.position.szi), entry: Number(p.position.entryPx), upnl: Number(p.position.unrealizedPnl), liq: Number(p.position.liquidationPx), lev: p.position.leverage.value, margin: Number(p.position.marginUsed) });
    const oo = await hl({ type: 'frontendOpenOrders', user: managed, dex });
    const push = (o, parent) => { out.orders.push({ oid: o.oid, coin: o.coin, side: o.side, sz: o.sz, type: o.orderType, isTrigger: !!o.isTrigger, trigger: o.triggerPx, px: o.limitPx, reduceOnly: o.reduceOnly, parent: parent ? parent.oid : null }); for (const ch of o.children || []) push(ch, o); };
    for (const o of oo || []) push(o, null);
    out.orders = out.orders.filter((o, k, all) => o.parent != null || !all.some((x) => x.oid === o.oid && x.parent != null)).filter((o, k, all) => all.findIndex((x) => x.oid === o.oid) === k);
  }
  // free spot + perp value counts every dollar once (margin shows as spot hold AND perp value)
  return finish(out, Number((Number(usdc.total) - Number(usdc.hold) + perp).toFixed(2)), Number((Number(usdc.total) - Number(usdc.hold)).toFixed(2)));
}
function finish(out, equity, free) {
  out.equity = equity; out.free = free;
  // dollars lost if every position's stop fills at its trigger
  out.openRisk = Number(out.positions.reduce((a, p) => {
    const st = out.orders.find((o) => o.coin === p.coin && /stop/i.test(o.type));
    return a + (st ? Math.max(0, (Number(st.trigger) - p.entry) * -p.szi) : Math.abs(p.szi) * p.entry * 0.05);
  }, 0).toFixed(2));
  // resting limit entries are risk too: what they lose if they fill and then hit their attached stop
  out.entries = out.orders.filter((o) => !o.reduceOnly && !o.isTrigger);
  out.pendingRisk = Number(out.entries.reduce((a, e) => {
    const st = out.orders.find((o) => o.parent === e.oid && /stop/i.test(o.type));
    return a + (st ? Math.abs(Number(st.trigger) - Number(e.px)) * Number(e.sz) : Number(e.sz) * Number(e.px) * 0.05);
  }, 0).toFixed(2));
  return out;
}

// Peak equity is remembered in .equity.json (not in git). Deposits raise the peak; after a withdrawal run `degen.js peak --reset`.
const EQUITY_FILE = path.join(__dirname, '.equity.json'); const DD_FLOOR = Number(process.env.DEGEN_DD_FLOOR || 30);
function brakeFor(equity, reset = false) {
  let st = {}; try { st = JSON.parse(fs.readFileSync(EQUITY_FILE, 'utf8')); } catch { /* first run */ }
  const peak = reset ? equity : Math.max(Number(st.peak || 0), equity);
  if (!MOCK && (reset || peak !== st.peak)) { try { fs.writeFileSync(EQUITY_FILE, JSON.stringify({ peak, at: new Date().toISOString() })); } catch { /* read-only checkout */ } }
  const dd = peak > 0 ? (1 - equity / peak) * 100 : 0;
  return { peak: Number(peak.toFixed(2)), equity, drawdownPct: Number(dd.toFixed(1)), floorPct: DD_FLOOR, scale: Number(Math.max(0, 1 - dd / DD_FLOOR).toFixed(3)) };
}

async function plan(args) {
  // Stops and targets as PERCENT OF MARGIN (GDEX style): --sl 20 --tp 60. Price levels still work: --stop PX --tp-px PX.
  const usage = 'need --coin --side long|short --sl PCT --tp PCT (percent of margin) and --risk USD or --margin USD [--lev max|half|N]';
  for (const k of ['coin', 'side']) if (args[k] == null) die(usage);
  // compounding: --margin-pct 20 puts up 20% of CURRENT equity, --risk-pct 4 risks 4% of it, so size grows and shrinks with the account
  let brake = null;
  if (args['margin-pct'] != null || args['risk-pct'] != null) {
    const eq = (await account(readAddress())).equity;
    // DRAWDOWN BRAKE (arXiv 1710.01503): percent sizes shrink in step with how far the account has fallen from its peak,
    // and reach zero at the floor, so the floor cannot be crossed by sizing alone. Floor = DEGEN_DD_FLOOR % (default 30).
    brake = brakeFor(eq);
    if (brake.scale <= 0) die(`drawdown brake: the account is ${brake.drawdownPct}% under its peak $${brake.peak}, at the ${DD_FLOOR}% floor. Percent sizing is off. Use fixed --margin, raise DEGEN_DD_FLOOR, or run: degen.js peak --reset`);
    if (args['margin-pct'] != null) args.margin = String(Number((eq * Number(args['margin-pct']) / 100 * brake.scale).toFixed(2)));
    else args.risk = String(Number((eq * Number(args['risk-pct']) / 100 * brake.scale).toFixed(2)));
  }
  if ((args.sl == null && args.stop == null) || (args.tp == null && args['tp-px'] == null) || (args.risk == null && args.margin == null)) die(usage);
  const coin = normCoin(args.coin);
  const isLong = String(args.side).toLowerCase() === 'long';
  const m = await market(coin);
  // Entry: market by default. --limit PX rests at your price. --join rests just inside the current price to try for the lower
  // resting-order fee. Live test 2026-11-22: GDEX checks the price against its own mark, which lagged the real one by ~0.05%,
  // so a --join order sits that far from the market and often does not fill.
  const joinBook = args.limit == null && !!args.join;
  // GDEX refuses a resting buy at or above the mark price (and a sell at or below it), so sit one price step inside the mark
  const tick = 10 ** (Math.floor(Math.log10(m.mark)) - 4);
  const cushion = Math.max(3 * tick, m.mark * 0.0002); // their mark price can lag ours by a few steps
  const joinPx = isLong ? Math.floor((Math.min(m.bid, m.mark) - cushion) / tick) * tick : Math.ceil((Math.max(m.ask, m.mark) + cushion) / tick) * tick;
  const limit = args.limit != null ? roundSig(Number(args.limit)) : joinBook ? roundSig(joinPx) : null;
  if (limit != null && !(limit > 0)) die('--limit needs a price');
  // a buy limit above the ask (or a sell limit below the bid) just fills now: that is a market order, say so
  if (limit != null && (isLong ? limit >= m.ask : limit <= m.bid)) die(`limit ${limit} is through the market (bid ${m.bid} / ask ${m.ask}) - it would fill at once. Drop --limit to go in at market.`);
  const entry = limit != null ? limit : (isLong ? m.ask : m.bid);
  const levReq = args.lev === 'half' ? Math.max(1, Math.floor(m.maxLev / 2)) : (!args.lev || args.lev === 'max') ? m.maxLev : Math.min(m.maxLev, Number(args.lev));
  const dir = isLong ? 1 : -1;
  const stop = args.stop != null ? Number(args.stop) : roundSig(entry * (1 - dir * Number(args.sl) / levReq / 100));
  const tp = args['tp-px'] != null ? Number(args['tp-px']) : roundSig(entry * (1 + dir * Number(args.tp) / levReq / 100));
  // --margin 50 --sl 20 means: put up $50, lose 20% of it ($10) at the stop
  const risk = args.risk != null ? Number(args.risk) : Number(args.margin) * levReq * Math.abs(entry - stop) / entry;
  if (isLong ? !(stop < entry && tp > entry) : !(stop > entry && tp < entry)) die(`levels wrong side of entry ${entry}: stop ${stop} tp ${tp}`);
  if (risk > MAX_RISK_USD) die(`risk $${risk} over the $${MAX_RISK_USD} per-trade rail (DEGEN_MAX_RISK_USD)`);
  const lev = levReq;
  const stopDist = Math.abs(entry - stop) / entry;
  const size = Number((risk / Math.abs(entry - stop)).toFixed(m.dp));
  const notional = size * entry;
  // isolated-style liquidation distance: initial margin 1/lev minus maintenance 1/(2*maxLev)
  const liqDist = 1 / lev - 1 / (2 * m.maxLev);
  if (stopDist > 0.7 * liqDist) die(`stop ${(stopDist * 100).toFixed(2)}% away is too close to liquidation (~${(liqDist * 100).toFixed(2)}%) at ${lev}x — drop leverage or tighten the stop`);
  if (notional < MIN_NOTIONAL) die(`notional $${notional.toFixed(2)} below HL $${MIN_NOTIONAL} minimum`);
  // noise check: a stop closer than one average 15m candle gets hit by ordinary movement, not by being wrong
  const k15 = await hl({ type: 'candleSnapshot', req: { coin: m.name, interval: '15m', startTime: Date.now() - 4 * 3600e3, endTime: Date.now() } }).catch(() => null);
  const avg15 = Array.isArray(k15) && k15.length ? k15.reduce((a, x) => a + (Number(x.h) - Number(x.l)) / Number(x.c), 0) / k15.length : 0;
  const warnings = [];
  if (avg15 && stopDist < avg15) warnings.push('stop is ' + (stopDist * 100).toFixed(2) + '% away but the average 15m candle is ' + (avg15 * 100).toFixed(2) + '% - normal movement can stop this out');
  if (joinBook) warnings.push('entry rests at ' + limit + ' (just ' + (isLong ? 'under' : 'over') + ' the price)' + ' to pay the lower fee. If price runs away it will NOT fill: add --market to go in now.');
  else if (limit != null) warnings.push('limit entry: nothing is open until price reaches ' + limit + ' (' + (Math.abs(limit / m.mark - 1) * 100).toFixed(2) + '% from here). It rests until filled or cancelled.');
  // fees against the stop: under 4 round trips of fee, the fee is over a quarter of what you risk
  const feeShare = (limit != null ? 0.00065 + 0.000932 : 0.000932 * 2) / stopDist;
  if (feeShare > 0.25) warnings.push('fees are ' + (feeShare * 100).toFixed(0) + '% of the amount risked: this stop is ' + (stopDist * 100).toFixed(2) + '% away, and under ' + (0.000932 * 2 * 4 * 100).toFixed(2) + '% the fee eats the trade. Lower leverage with the same % stop, or a wider stop.');
  if (brake && brake.scale < 1) warnings.push(`drawdown brake: account is ${brake.drawdownPct}% under its peak $${brake.peak}, so this size is cut to ${(brake.scale * 100).toFixed(0)}% of the asked percent`);
  return {
    brake, orderType: limit != null ? 'limit' : 'market', joinBook, limit, mark: m.mark, awayPct: limit != null ? Number(((limit / m.mark - 1) * 100).toFixed(2)) : 0,
    warnings, stopVsAvg15mCandle: avg15 ? Number((stopDist / avg15).toFixed(2)) : null,
    coin, side: isLong ? 'long' : 'short', isLong, lev, maxLev: m.maxLev, entry, stop, tp, size,
    notional: Number(notional.toFixed(2)), margin: Number((notional / lev).toFixed(2)),
    stopPct: Number((stopDist * 100).toFixed(2)), slPctOfMargin: Number((stopDist * lev * 100).toFixed(1)), tpPctOfMargin: Number((Math.abs(tp - entry) / entry * lev * 100).toFixed(1)), liqPct: Number((liqDist * 100).toFixed(2)),
    risk: Number((size * Math.abs(entry - stop)).toFixed(2)), reward: Number((size * Math.abs(tp - entry)).toFixed(2)),
    rr: Number((Math.abs(tp - entry) / Math.abs(entry - stop)).toFixed(2)),
    // fees measured on this account: 0.0932% per side at market, about 0.065% for a resting limit
    feeEst: Number((notional * (limit != null ? 0.00065 + 0.000932 : 0.000932 * 2)).toFixed(2)),
    feePctOfMargin: Number(((limit != null ? 0.00065 + 0.000932 : 0.000932 * 2) * lev * 100).toFixed(1)),
    netIfTarget: Number((size * Math.abs(tp - entry) - notional * (limit != null ? 0.00065 * 2 : 0.000932 + 0.00065)).toFixed(2)),
    netIfStopped: Number((-size * Math.abs(entry - stop) - notional * (limit != null ? 0.00065 + 0.000932 : 0.000932 * 2)).toFixed(2)),
    // share of trades that must hit the target just to break even after fees, with this stop and target
    breakevenWinPct: (() => { const fw = notional * (limit != null ? 0.00065 * 2 : 0.000932 + 0.00065); const fl = notional * (limit != null ? 0.00065 + 0.000932 : 0.000932 * 2); const w = size * Math.abs(tp - entry) - fw; const l = size * Math.abs(entry - stop) + fl; return w > 0 ? Number((l / (l + w) * 100).toFixed(0)) : 100; })(), fundingAprPct: Number((m.funding * 876000).toFixed(1)),
  };
}

// One signed call to a GDEX HL endpoint the SDK does not wrap yet (modify_order, add_position_tpsl).
async function gdexCall(skill, creds, action, types, valuesAfterNonce, endpoint) {
  const { ethers } = require(path.join(GDEX_DIR, 'node_modules', 'ethers'));
  const SDK = require(path.join(GDEX_DIR, 'dist'));
  const nonce = SDK.generateGdexNonce().toString();
  const data = ethers.AbiCoder.defaultAbiCoder().encode(types, [nonce, ...valuesAfterNonce]).slice(2);
  const signature = SDK.signHlActionMessage(action, creds.walletAddress, data, creds.sessionPrivateKey);
  const computedData = SDK.buildEncryptedGdexPayload({ apiKey: creds.apiKey, userId: creds.walletAddress, data, signature });
  return skill.client.post(endpoint, { computedData }).catch((e) => ({ isSuccess: false, error: String(e.message || e), status: e.response?.status || e.statusCode, body: e.response?.data }));
}
const S6 = ['string', 'string', 'string', 'string', 'string', 'string'];

// Move a stop, a target, both, or a resting entry. Works on an open position or on a resting limit order.
async function adjust(cmd, args, wallet) {
  if (!args.coin) die(`${cmd} needs --coin`);
  const coin = normCoin(args.coin); const same = (o) => o.coin.toLowerCase() === coin.toLowerCase();
  const acct = await account(wallet.managed); const m = await market(coin);
  const pos = acct.positions.find(same);
  const ent = acct.entries.find((o) => same(o) && (!args.oid || String(o.oid) === String(args.oid)));
  if (!pos && !ent) die(`no open position and no resting entry order on ${coin}`);
  const isLong = pos ? pos.szi > 0 : ent.side === 'B'; const dir = isLong ? 1 : -1;
  const ref = pos ? pos.entry : Number(ent.px);           // percent moves count from the entry (or the limit price)
  const lev = pos ? pos.lev : (args.lev ? Number(args.lev) : m.maxLev);
  const size = pos ? Math.abs(pos.szi) : Number(ent.sz);
  const live = pos ? m.mark : Number(ent.px);              // triggers must sit on the right side of this
  const mine = acct.orders.filter((o) => same(o) && o.isTrigger && o.reduceOnly && (pos ? true : o.parent === ent.oid));
  const curSl = mine.find((o) => /^stop/i.test(o.type));
  // the target is either a take-profit trigger or a plain resting reduce-only limit (cheaper: it fills as a maker)
  const curTp = mine.find((o) => /^take/i.test(o.type)) || acct.orders.find((o) => same(o) && !o.isTrigger && o.reduceOnly && pos && ((Number(o.px) - pos.entry) * (pos.szi > 0 ? 1 : -1) > 0));
  const changes = []; const warnings = [];
  if (!pos && !args.lev && (args.pct != null || args.lock != null || args['sl-pct'] != null || args['tp-pct'] != null)) warnings.push(`a resting order does not show its leverage: percents were worked out at max ${m.maxLev}x. Add --lev N if you placed it at another leverage.`);

  if (args.off) { // take a target off to let a winner run. Taking a STOP off leaves the trade naked: only with DEGEN_ALLOW_NAKED=1
    if (cmd !== 'tp' && cmd !== 'sl') die('--off works with tp or sl');
    if (cmd === 'sl' && process.env.DEGEN_ALLOW_NAKED !== '1') die('removing a stop leaves the position naked - refused (set DEGEN_ALLOW_NAKED=1 if you really mean it)');
    const cur = cmd === 'tp' ? curTp : curSl;
    if (!cur) die(`no ${cmd === 'tp' ? 'target' : 'stop'} on ${coin} to remove`);
    if (args.dry) return { ok: true, dry: true, coin, wouldRemove: cur };
    const w = wallet.pk ? wallet : loadWallet();
    const res = await signedCall(w, (skill, creds) => skill.hlCancelOrder({ ...creds, coin, orderId: String(cur.oid) }));
    await new Promise((r) => setTimeout(r, 2500));
    const after = await account(wallet.managed);
    const out = { ok: !(res && res.isSuccess === false), action: cmd + '-off', coin, removed: cur, res, ordersNow: after.orders.filter(same) };
    fs.appendFileSync(JOURNAL, JSON.stringify({ t: new Date().toISOString(), ...out }) + '\n');
    return out;
  }
  if (cmd === 'entry') {
    if (!ent) die(`no resting entry order on ${coin}`);
    if (args.to == null) die('entry needs --to PX');
    const px = roundSig(Number(args.to));
    if (isLong ? px >= m.ask : px <= m.bid) die(`${px} is through the market (bid ${m.bid} / ask ${m.ask}) - cancel and go in at market instead`);
    changes.push({ what: 'entry', oid: ent.oid, from: Number(ent.px), to: px });
    if (curSl || curTp) warnings.push('the attached stop and target stay at their old prices - move them too if you want the same percent');
  }
  const wantSl = cmd === 'sl' ? { to: args.to, pct: args.pct, be: args.be, lock: args.lock } : cmd === 'move' ? { to: args['sl-to'], pct: args['sl-pct'], be: args.be, lock: args.lock } : {};
  const wantTp = cmd === 'tp' ? { to: args.to, pct: args.pct } : cmd === 'move' ? { to: args['tp-to'], pct: args['tp-pct'] } : {};
  const has = (w) => Object.values(w).some((v) => v != null);
  if (cmd !== 'entry' && !has(wantSl) && !has(wantTp)) die(cmd === 'sl' ? 'sl needs --to PX | --pct N | --be | --lock N' : cmd === 'tp' ? 'tp needs --to PX | --pct N' : 'move needs --sl-to/--sl-pct/--be/--lock and/or --tp-to/--tp-pct');
  if (has(wantSl)) {
    // --pct 10 = lose 10% of margin. --be = entry plus round-trip fees. --lock 30 = stop in profit, +30% of margin kept.
    const px = roundSig(wantSl.to != null ? Number(wantSl.to) : wantSl.be ? ref * (1 + dir * 0.0012) : wantSl.lock != null ? ref * (1 + dir * Number(wantSl.lock) / lev / 100) : ref * (1 - dir * Number(wantSl.pct) / lev / 100));
    if (isLong ? px >= live : px <= live) die(`stop ${px} is on the wrong side of ${pos ? 'the mark' : 'the limit'} ${live} for a ${isLong ? 'long' : 'short'} - it would trigger at once`);
    const loss = Math.max(0, (ref - px) * dir * size);
    if (loss > MAX_RISK_USD) die(`stop ${px} would risk $${loss.toFixed(2)}, over the $${MAX_RISK_USD} per-trade rail (DEGEN_MAX_RISK_USD)`);
    if (pos && pos.liq && (isLong ? px <= pos.liq : px >= pos.liq)) die(`stop ${px} is past liquidation ${pos.liq} - it would never trigger`);
    if (curSl && (Number(curSl.trigger) - px) * dir > 0) warnings.push('this LOOSENS the stop: more can be lost than before');
    changes.push({ what: 'stop', oid: curSl ? curSl.oid : null, from: curSl ? Number(curSl.trigger) : null, to: px, pnlAtStop: Number(((px - ref) * dir * size).toFixed(2)), marginPct: Number(((px / ref - 1) * dir * lev * 100).toFixed(1)) });
  }
  if (has(wantTp)) {
    const px = roundSig(wantTp.to != null ? Number(wantTp.to) : ref * (1 + dir * Number(wantTp.pct) / lev / 100));
    if (isLong ? px <= live : px >= live) die(`target ${px} is on the wrong side of ${pos ? 'the mark' : 'the limit'} ${live} for a ${isLong ? 'long' : 'short'} - it would fill at once`);
    changes.push({ what: 'target', oid: curTp ? curTp.oid : null, resting: !!(curTp && !curTp.isTrigger), maker: !!args.maker, from: curTp ? Number(curTp.isTrigger ? curTp.trigger : curTp.px) : null, to: px, pnlAtTarget: Number(((px - ref) * dir * size).toFixed(2)), marginPct: Number(((px / ref - 1) * dir * lev * 100).toFixed(1)) });
  }
  // --maker on a target: swap the take-profit trigger for a plain resting reduce-only limit at that price
  // Live test 2026-11-22: GDEX's place_order with reduceOnly did NOT rest at the target price - it closed the position at market.
  // So a resting take-profit is not available through GDEX today. Refuse rather than close a trade by surprise.
  if (args.maker) die('--maker is off: through GDEX a reduce-only limit order closes the position at market instead of resting (seen live 2026-11-22)');
  const swap = null;
  if (swap && !pos) die('--maker needs an open position: a resting take-profit cannot sit on an order that has not filled');
  const need = changes.filter((c) => c.what !== 'entry' && c.oid == null && c !== swap);
  if (need.length && !pos) die(`the resting order on ${coin} has no attached ${need.map((c) => c.what).join(' / ')} to move - cancel it and place it again with one`);
  const base = { coin, side: isLong ? 'long' : 'short', on: pos ? 'position' : 'resting order', entry: ref, lev, size, mark: m.mark, changes, warnings };
  if (args.dry) return { ok: true, dry: true, ...base };

  const w = wallet.pk ? wallet : loadWallet(); const results = [];
  if (swap) {
    // place the resting limit first, then remove the trigger, so the position is never without a target order
    const put = await signedCall(w, (skill, creds) => skill.hlPlaceOrder({ coin, isLong: !isLong, price: String(swap.to), size: String(size), reduceOnly: true, ...creds }));
    results.push({ what: 'target', via: 'resting reduce-only limit', res: put });
    if (put && put.isSuccess !== false && !put.error && swap.oid != null) results.push({ what: 'old target trigger', via: 'cancel', res: await signedCall(w, (skill, creds) => skill.hlCancelOrder({ ...creds, coin, orderId: String(swap.oid) })) });
  }
  for (const c of changes.filter((x) => x.oid != null && x !== swap)) {
    const vals = (c.what === 'entry' || c.resting) ? [coin, String(c.oid), String(c.to), '', ''] : [coin, String(c.oid), '', '', String(c.to)];
    results.push({ what: c.what, via: 'modify_order', res: await signedCall(w, (skill, creds) => gdexCall(skill, creds, 'hl_modify_order', S6, vals, '/v1/hl/modify_order')) });
  }
  if (need.length) {
    const tp = need.find((c) => c.what === 'target'); const sl = need.find((c) => c.what === 'stop');
    results.push({ what: need.map((c) => c.what).join('+'), via: 'add_position_tpsl', res: await signedCall(w, (skill, creds) => gdexCall(skill, creds, 'hl_add_position_tpsl',
      ['string', 'string', 'string', 'string', 'string', 'bool', 'string', 'string', 'bool'], [coin, '', tp ? String(tp.to) : '', '', true, sl ? String(sl.to) : '', '', true], '/v1/hl/add_position_tpsl')) });
  }
  await new Promise((r) => setTimeout(r, 2500));
  const after = await account(wallet.managed);
  const failed = results.filter((r) => !r.res || r.res.isSuccess === false || r.res.error);
  const out = { ok: failed.length === 0, action: cmd, ...base, results, ordersNow: after.orders.filter(same), positions: after.positions.filter(same) };
  if (failed.length) out.error = 'NOT all changes went through - check ordersNow, your old stop/target may still be the live one';
  fs.appendFileSync(JOURNAL, JSON.stringify({ t: new Date().toISOString(), ...out }) + '\n');
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === 'plan') return plan(args);
  // reads and --dry previews only need the public address; the wallet file is opened only to sign a live action
  const readOnly = cmd === 'status' || cmd === 'orders' || cmd === 'peak' || args.dry;
  const wallet = readOnly ? { managed: readAddress() } : loadWallet();
  if (cmd === 'status') { const a = await account(wallet.managed); a.brake = brakeFor(a.equity); return a; }
  if (cmd === 'peak') { const a = await account(readAddress()); return { ok: true, ...brakeFor(a.equity, !!args.reset) }; }
  if (cmd === 'fire') {
    let p = await plan(args);
    const acct = await account(wallet.managed);
    if (p.margin > acct.free * 0.98) die(`margin $${p.margin} needed, only $${acct.free} free`);
    if (acct.openRisk + acct.pendingRisk + p.risk > acct.equity * MAX_RISK_PCT / 100) die(`total risk $${(acct.openRisk + acct.pendingRisk + p.risk).toFixed(2)} (open $${acct.openRisk} + resting $${acct.pendingRisk} + this $${p.risk}) would pass ${MAX_RISK_PCT}% of equity $${acct.equity}`);
    const send = () => signedCall(wallet, (skill, creds) => skill.hlCreateOrder({
      coin: p.coin, isLong: p.isLong, price: String(p.entry), size: String(p.size), reduceOnly: false, isMarket: p.orderType !== 'limit',
      tpPrice: String(roundSig(p.tp)), slPrice: String(roundSig(p.stop)), leverage: p.lev, ...creds,
    }));
    let res = await send();
    // GDEX checks a resting entry against ITS mark price, which can lag the real one. When it refuses a book-joining
    // entry it names that mark: re-plan once, one cushion inside it. A refused order was never placed.
    const lag = p.joinBook && res && res.isSuccess === false && /set the limit price (below|above) ([\d.]+)/.exec(String(res.error || ''));
    if (lag) {
      const theirs = Number(lag[2]); const step = Math.max(3 * 10 ** (Math.floor(Math.log10(theirs)) - 4), theirs * 0.0002);
      p = await plan({ ...args, limit: String(roundSig(p.isLong ? theirs - step : theirs + step)) }); p.joinBook = true; p.gdexMark = theirs;
      res = await send();
    }
    if (res && res.isSuccess === false) die(`rejected: ${JSON.stringify(res)}`);
    await new Promise((r) => setTimeout(r, 4000));
    const after = await account(wallet.managed);
    const out = { ok: true, action: p.orderType === 'limit' ? 'fire-limit' : 'fire', resting: p.orderType === 'limit' ? after.entries.filter((o) => o.coin === p.coin) : undefined, plan: p, positions: after.positions, orders: after.orders, equity: after.equity };
    fs.appendFileSync(JOURNAL, JSON.stringify({ t: new Date().toISOString(), ...out, thesis: args.thesis || '' }) + '\n');
    return out;
  }
  if (cmd === 'flat') {
    const acct = await account(wallet.managed);
    const todo = acct.positions.filter((p) => !args.coin || p.coin.toLowerCase() === normCoin(args.coin).toLowerCase());
    if (!todo.length) return { ok: true, action: 'flat', closed: [] };
    const closed = [];
    // close = a reduce-only market order the other way (the SDK's closePerpPosition cannot load on Node 20)
    for (const p of todo) {
      const mk = await market(normCoin(p.coin));
      closed.push({ coin: p.coin, res: await signedCall(wallet, (skill, creds) => skill.hlCreateOrder({ coin: normCoin(p.coin), isLong: p.szi < 0, price: String(p.szi < 0 ? mk.ask : mk.bid), size: String(Math.abs(p.szi)), reduceOnly: true, isMarket: true, tpPrice: '', slPrice: '', ...creds })) });
    }
    await new Promise((r) => setTimeout(r, 4000));
    const after = await account(wallet.managed);
    const left = after.positions.filter((x) => todo.some((t) => t.coin === x.coin));
    const out = { ok: left.length === 0, action: 'flat', closed, positions: after.positions, orders: after.orders, equity: after.equity };
    if (left.length) out.error = 'STILL OPEN: ' + left.map((x) => x.coin).join(', ') + ' - the close did not go through';
    fs.appendFileSync(JOURNAL, JSON.stringify({ t: new Date().toISOString(), ...out }) + '\n');
    return out;
  }
  if (cmd === 'orders') { const a = await account(wallet.managed); return { ok: true, entries: a.entries, pendingRisk: a.pendingRisk, orders: a.orders, positions: a.positions.map((x) => ({ coin: x.coin, szi: x.szi, entry: x.entry, lev: x.lev })) }; }
  if (cmd === 'cancel') {
    const acct = await account(wallet.managed);
    if (!args.all && !args.coin) die('cancel needs --coin X, or --oid N --coin X, or --all');
    const todo = acct.entries.filter((o) => (args.all || o.coin.toLowerCase() === normCoin(args.coin).toLowerCase()) && (!args.oid || String(o.oid) === String(args.oid)));
    if (!todo.length) return { ok: true, action: 'cancel', cancelled: [], note: 'no resting entry orders matched' };
    if (args.dry) return { ok: true, dry: true, wouldCancel: todo };
    const cancelled = [];
    for (const o of todo) cancelled.push({ oid: o.oid, coin: o.coin, px: o.px, res: await signedCall(wallet, (skill, creds) => skill.hlCancelOrder({ ...creds, coin: normCoin(o.coin), orderId: String(o.oid) })) });
    await new Promise((r) => setTimeout(r, 2500));
    const after = await account(wallet.managed);
    const out = { ok: true, action: 'cancel', cancelled, entries: after.entries, positions: after.positions };
    fs.appendFileSync(JOURNAL, JSON.stringify({ t: new Date().toISOString(), ...out }) + '\n');
    return out;
  }
  if (['sl', 'tp', 'move', 'entry'].includes(cmd)) return adjust(cmd, args, wallet);
  die('commands: status | plan | fire | flat | orders | cancel | entry | sl | tp | move | peak');
}
main().then((o) => { console.log(JSON.stringify(o, null, 1)); process.exit(0); }).catch((e) => die(String(e.stack || e)));
