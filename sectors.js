#!/usr/bin/env node
/**
 * SECTORS — the whole HyperLiquid perp board grouped by sector, so you can see where money is rotating. Read-only.
 *
 *   node sectors.js                  # sector table + leaders and laggards in each
 *   node sectors.js --sector semis   # every market in one sector (name match)
 *   node sectors.js --json | --no-color
 *
 * 24h = volume-weighted change of the sector. ~2h = the same for its 3 biggest markets (last 2 hourly candles).
 * breadth = markets up / total. A sector moving with wide breadth is a theme; one name moving alone is a story.
 */
'use strict';
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const COLOR = !argv.includes('--no-color') && !JSON_OUT && !process.env.NO_COLOR;
const paint = (c) => (t) => (COLOR ? `\x1b[${c}m${t}\x1b[0m` : String(t));
const C = { red: paint('1;31'), green: paint('1;32'), yellow: paint('1;33'), cyan: paint('1;36'), dim: paint('2'), bold: paint('1') };
const pad = (s, n) => String(s).padStart(n); const padE = (s, n) => String(s).padEnd(n);
const fmt = (v) => (v >= 1000 ? v.toFixed(0) : v >= 10 ? v.toFixed(2) : v >= 0.1 ? v.toFixed(4) : v.toPrecision(4));
const sg = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d) + '%';
const col = (v) => (v >= 0 ? C.green : C.red);

// ticker -> sector. Stock-venue tickers are matched without their venue prefix; a few clashes are pinned by full name.
const S = {
  'Crypto majors': 'BTC ETH SOL XRP BNB',
  'Crypto L1 / L2': 'NEAR ADA TRX SUI AVAX DOT LTC BCH HBAR ICP APT TIA ATOM STX CFX ALGO SEI MINA POL S KAS NEO ETC XLM MON INIT BERA MNT OP ARB STRK ZK INJ XPL GRAM MEGA FOGO MOVE LINEA ZETA DYM MANTA IOTA AZTEC HEMI SOPH CELO STABLE BSV MERL SAGA ALT ZRO W IMX',
  'Privacy coins': 'ZEC XMR DASH ZEN',
  'DeFi': 'HYPE AAVE UNI LIT ENA CRV ONDO JUP AERO ETHFI SKY PENDLE MORPHO LDO GMX CAKE DYDX SNX COMP SUSHI RUNE LINK PYTH JTO ASTER RESOLV USUAL SYRUP EIGEN REZ AVNT MET APEX PURR WLFI ENS UMA TRB BLUR ZORA STBL RSR BANANA para:DRV',
  'AI crypto': 'VVV TAO FET WLD VIRTUAL GRASS RENDER IO AIXBT KAITO GRIFFAIN NIL BIO PROVE 0G FIL AR',
  'Memecoins': 'PUMP kPEPE DOGE TRUMP FARTCOIN kSHIB kBONK WIF PENGU USELESS SPX MELANIA kFLOKI POPCAT BRETT GOAT MOODENG PNUT MEME BOME TURBO kNEIRO NOT HMSTR CASHCAT PEOPLE kLUNC ANIME',
  'Semis & memory': 'NVDA SOXL MU SNDK DRAM SKHX SKHY SMSN TSM AVGO MRVL INTC AMD ARM QCOM AMAT ASML LRCX KIOXIA CXMT SMH WDC para:STX TER CRDO GIGADEV UMC CAMBRICON MUU SMCI LITE AAOI COHR CIEN GLW SNXX',
  'AI & private companies': 'ANT ANTH OAI SPCX UNITREE MINIMAX ZHIPU SHEIN NBIS CRWV IREN CBRS PLTR ORCL CIFR BE VST GEV',
  'Big tech & software': 'GOOGL MSFT AAPL AMZN META TSLA NFLX IBM DELL BABA SOFTBANK XIAOMI NOW NET CRWD PANW ZM RDDT TTWO EBAY IGV MELI JIO RELIANCE HYUNDAI MAGS',
  'Crypto stocks': 'MSTR COIN CRCL HOOD BMNR STRC SOFI GME',
  'Indices': 'XYZ100 SP500 KR200 JP225 NIFTY EWY EWT EWZ EWJ KORU KSTR para:TOTAL2 para:OTHERS para:BTCD',
  'Commodities': 'GOLD SILVER CL BRENTOIL NATGAS COPPER PLATINUM PALLADIUM PAXG URNM GDX XLE CVX HO USAR',
  'Rates, FX & vol': 'JPY EUR GBP TLT 2Y 10Y 30Y BVIV',
};
const MAP = new Map();
for (const [sec, list] of Object.entries(S)) for (const t of list.split(' ')) MAP.set(t, sec);
const sectorOf = (name) => { const i = name.indexOf(':'); return MAP.get(name) || (i === -1 ? MAP.get(name) || 'Other crypto' : MAP.get(name.slice(i + 1)) && !['S', 'STX', 'W', 'IO', 'AR', 'MET', 'ME'].includes(name.slice(i + 1)) ? MAP.get(name.slice(i + 1)) : 'Other stocks'); };

async function hl(body) {
  for (let k = 0; ; k += 1) {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j != null || k >= 6) return j;
    await new Promise((res) => setTimeout(res, 800 * (k + 1)));
  }
}
async function main() {
  const dexes = ['', ...(await hl({ type: 'perpDexs' })).filter(Boolean).map((d) => d.name)];
  const all = [];
  for (const dex of dexes) {
    const res = await hl({ type: 'metaAndAssetCtxs', dex }); if (!res) continue;
    res[0].universe.forEach((u, k) => {
      const x = res[1][k]; if (u.isDelisted || !x || !Number(x.dayNtlVlm) || !Number(x.prevDayPx)) return;
      const px = Number(x.markPx);
      all.push({ coin: u.name, sector: sectorOf(u.name), px, maxLev: u.maxLeverage, vol: Number(x.dayNtlVlm), oi: Number(x.openInterest) * px, chg: (px / Number(x.prevDayPx) - 1) * 100, fundApr: Number(x.funding) * 876000 });
    });
  }
  const groups = new Map();
  for (const m of all) { if (!groups.has(m.sector)) groups.set(m.sector, []); groups.get(m.sector).push(m); }
  const now = Date.now(); const rows = [];
  for (const [sector, ms] of groups) {
    ms.sort((a, b) => b.vol - a.vol);
    const vol = ms.reduce((a, m) => a + m.vol, 0);
    for (const m of ms.slice(0, 3)) { // ~2h move for the three biggest markets
      const c = await hl({ type: 'candleSnapshot', req: { coin: m.coin, interval: '1h', startTime: now - 3 * 3600e3, endTime: now } });
      if (Array.isArray(c) && c.length >= 2) m.h2 = (Number(c[c.length - 1].c) / Number(c[c.length - 2].o) - 1) * 100;
    }
    const top3 = ms.slice(0, 3).filter((m) => m.h2 != null); const v3 = top3.reduce((a, m) => a + m.vol, 0) || 1;
    const liquid = ms.filter((m) => m.vol >= 1e6); const pool = liquid.length >= 2 ? liquid : ms;
    const byChg = [...pool].sort((a, b) => b.chg - a.chg);
    rows.push({ sector, n: ms.length, up: ms.filter((m) => m.chg >= 0).length, vol, oi: ms.reduce((a, m) => a + m.oi, 0),
      chg: ms.reduce((a, m) => a + m.chg * m.vol, 0) / vol, h2: top3.reduce((a, m) => a + m.h2 * m.vol, 0) / v3,
      fundApr: ms.reduce((a, m) => a + m.fundApr * m.vol, 0) / vol, leaders: byChg.slice(0, 3), laggards: byChg.slice(-3).reverse().filter((m) => !byChg.slice(0, 3).includes(m)), markets: ms });
  }
  rows.sort((a, b) => b.chg - a.chg);
  const si = argv.indexOf('--sector');
  if (JSON_OUT) { console.log(JSON.stringify(rows.map(({ markets, ...r }) => ({ ...r, markets: si !== -1 ? markets : undefined })), null, 1)); return; }
  const tag = (m) => `${C.yellow(m.coin)} ${col(m.chg)(sg(m.chg))}`;
  if (si !== -1) {
    const q = String(argv[si + 1] || '').toLowerCase(); const r = rows.find((x) => x.sector.toLowerCase().includes(q));
    if (!r) { console.log('sectors: ' + rows.map((x) => x.sector).join(' | ')); return; }
    console.log(`\n${C.cyan(r.sector.toUpperCase())}  ${r.n} markets, ${r.up} up   24h ${col(r.chg)(sg(r.chg))}   volume $${(r.vol / 1e6).toFixed(0)}M   ${C.dim(new Date().toISOString().slice(0, 16) + 'Z')}`);
    console.log(C.dim(`\n${pad('market', 14)} ${pad('price', 10)} ${pad('24h', 8)} ${pad('vol 24h', 9)} ${pad('open int', 9)} ${pad('lev', 4)} ${pad('funding/yr', 11)}`));
    for (const m of [...r.markets].sort((a, b) => b.chg - a.chg)) console.log(`${C.yellow(pad(m.coin, 14))} ${pad(fmt(m.px), 10)} ${col(m.chg)(pad(sg(m.chg), 8))} ${pad('$' + (m.vol / 1e6).toFixed(1) + 'M', 9)} ${pad('$' + (m.oi / 1e6).toFixed(1) + 'M', 9)} ${pad(m.maxLev + 'x', 4)} ${(Math.abs(m.fundApr) >= 30 ? C.yellow : C.dim)(pad(m.fundApr.toFixed(0) + '%', 11))}`);
    console.log(''); return;
  }
  const tot = all.length; const up = all.filter((m) => m.chg >= 0).length;
  console.log(`\n${C.cyan('SECTORS')}  ${tot} live perps, ${C.green(up + ' up')} / ${C.red(tot - up + ' down')}   ${C.dim(new Date().toISOString().slice(0, 16) + 'Z')}`);
  console.log(C.dim(`\n${padE('sector', 24)} ${pad('24h', 7)} ${pad('~2h', 7)} ${pad('breadth', 8)} ${pad('vol 24h', 9)} ${pad('open int', 9)} ${pad('funding/yr', 11)}`));
  for (const r of rows) {
    console.log(`${C.bold(padE(r.sector, 24))} ${col(r.chg)(pad(sg(r.chg), 7))} ${col(r.h2)(pad(sg(r.h2), 7))} ${pad(r.up + '/' + r.n, 8)} ${pad('$' + (r.vol / 1e6).toFixed(0) + 'M', 9)} ${pad('$' + (r.oi / 1e6).toFixed(0) + 'M', 9)} ${(Math.abs(r.fundApr) >= 30 ? C.yellow : C.dim)(pad(r.fundApr.toFixed(0) + '%', 11))}`);
    console.log(`  ${C.dim('lead')} ${r.leaders.map(tag).join('  ')}${r.laggards.length ? '   ' + C.dim('lag') + ' ' + r.laggards.map(tag).join('  ') : ''}`);
  }
  console.log(C.dim(`\nLeaders and laggards need $1M+ of 24h volume. Next: node sectors.js --sector <name>  |  node mom.js <market>\n`));
}
main().catch((e) => { require('./lib.js').bail(e); });
