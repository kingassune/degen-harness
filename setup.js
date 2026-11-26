#!/usr/bin/env node
/**
 * SETUP — make a wallet, see where to send money, move it in and out. Run this first.
 *
 *   node setup.js                       create your wallet (once) and show the deposit address
 *   node setup.js check                 is everything installed, and where is the money
 *   node setup.js deposit --amount 50   move USDC from your deposit address (Arbitrum) into HyperLiquid     (LIVE)
 *   node setup.js withdraw --amount 50  move USDC from HyperLiquid back to your deposit address (Arbitrum)  (LIVE)
 *   node setup.js send --to 0x... --amount 50    send USDC from your deposit address to any Arbitrum address (LIVE)
 *
 *   node setup.js claude                install the /degen skill for Claude Code (so you can drive it by talking from any folder)
 *
 * Add --dry to deposit / withdraw / send to see what would happen without sending anything.
 * The wallet file holds a private key. It is written to ~/.degen/wallet.json (mode 600), outside this folder, and never printed.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { walletPath, loadSdk } = require('./lib.js');

const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // native USDC on Arbitrum One
const ARB_RPC = process.env.DEGEN_ARB_RPC || 'https://arb1.arbitrum.io/rpc';
const CHAIN = 42161; const CHAIN_NAME = 'Arbitrum (HyperLiquid)';
const CONFIG = path.join(__dirname, 'config.json');
const SESSION = path.join(__dirname, '.session.json');
const say = (...a) => console.log(...a);
const fail = (m) => { console.log('\n  ✗ ' + m + '\n'); process.exit(1); };
const args = (() => { const o = { _: [] }; const v = process.argv.slice(2); for (let i = 0; i < v.length; i += 1) { if (v[i].startsWith('--')) { o[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[(i += 1)] : 'true'; } else o._.push(v[i]); } return o; })();

async function rpc(method, params) {
  const r = await fetch(ARB_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) }).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => null) : null; return j && j.result != null ? j.result : null;
}
async function hl(body) {
  for (let k = 0; k < 4; k += 1) {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null; if (j != null) return j;
    await new Promise((res) => setTimeout(res, 1200 * (k + 1)));
  }
  return null;
}
// Where the money is: the deposit address on Arbitrum, and the HyperLiquid account the harness trades from.
async function balances(addr) {
  const [usdcHex, ethHex, spot, perp, xyz] = await Promise.all([
    rpc('eth_call', [{ to: USDC, data: '0x70a08231000000000000000000000000' + addr.slice(2).toLowerCase() }, 'latest']), rpc('eth_getBalance', [addr, 'latest']),
    hl({ type: 'spotClearinghouseState', user: addr }), hl({ type: 'clearinghouseState', user: addr, dex: '' }), hl({ type: 'clearinghouseState', user: addr, dex: 'xyz' })]);
  const u = spot ? (spot.balances || []).find((b) => b.coin === 'USDC') || { total: 0, hold: 0 } : null;
  const hlEq = spot && perp ? Number(u.total) - Number(u.hold) + [perp, xyz].filter((x) => x && x.marginSummary).reduce((n, x) => n + Number(x.marginSummary.accountValue), 0) : null;
  return { arbUsdc: usdcHex == null ? null : Number(BigInt(usdcHex)) / 1e6, arbEth: ethHex == null ? null : Number(BigInt(ethHex)) / 1e18, hl: hlEq };
}
const usd = (v) => (v == null ? 'could not read (try again)' : '$' + v.toFixed(2));
function readWallet() {
  const p = walletPath(); if (!fs.existsSync(p)) return null;
  const w = JSON.parse(fs.readFileSync(p, 'utf8')); const managed = w.managed && w.managed[CHAIN_NAME] && w.managed[CHAIN_NAME].address;
  return { path: p, control: w.control && w.control.address, managed, mode: (fs.statSync(p).mode & 0o777).toString(8) };
}
function fundingHelp(managed, b) {
  say('\n  HOW TO FUND IT');
  say('  1. Send USDC on the ARBITRUM ONE network to your deposit address:');
  say('\n       ' + managed + '\n');
  say('     At least $11 (the smallest deposit is $10 plus a 1% buffer). Any exchange or wallet that can withdraw');
  say('     "USDC - Arbitrum One" works. Do not send on another network: it will not arrive.');
  say('     Add about $1 of ETH on Arbitrum too, in case the move needs gas.');
  say('  2. When it lands:   node setup.js check');
  say('  3. Move it in:      node setup.js deposit --amount 50      (about 10 minutes to show up)');
  say('  4. Trade:           node degen.js status');
  if (b) say(`\n  Now: deposit address ${usd(b.arbUsdc)} USDC on Arbitrum, HyperLiquid account ${usd(b.hl)}.`);
}

async function init() {
  const have = readWallet();
  if (have && have.managed) {
    say(`\n  ✓ Wallet already set up (${have.path}). Nothing was changed.`);
    if (!fs.existsSync(CONFIG)) { fs.writeFileSync(CONFIG, JSON.stringify({ address: have.managed }) + '\n'); say('  ✓ Wrote config.json with your trading address.'); }
    fundingHelp(have.managed, await balances(have.managed)); return;
  }
  if (have) fail(`A wallet file exists at ${have.path} but has no ${CHAIN_NAME} address. Move it aside or set DEGEN_WALLET to a new path, then run this again.`);
  const { SDK, ethers } = loadSdk(); const p = walletPath();
  const w = SDK.generateEvmWallet();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const file = { createdAt: new Date().toISOString(), control: { address: w.address, privateKey: w.privateKey, mnemonic: w.mnemonic || null }, managed: {} };
  fs.writeFileSync(p, JSON.stringify(file, null, 2), { mode: 0o600, flag: 'wx' }); fs.chmodSync(p, 0o600); // saved before anything else, so the key cannot be lost
  const apiKey = process.env.GDEX_API_KEY || SDK.GDEX_API_KEY_PRIMARY;
  const skill = new SDK.GdexSkill({ timeout: 60000, maxRetries: 1 }); skill.loginWithApiKey(apiKey);
  const kp = SDK.generateGdexSessionKeyPair(); const nonce = SDK.generateGdexNonce().toString();
  const sig = await new ethers.Wallet(w.privateKey).signMessage(SDK.buildGdexSignInMessage(w.address, nonce, kp.sessionKey));
  const payload = SDK.buildGdexSignInComputedData({ apiKey, userId: w.address, sessionKey: kp.sessionKey, nonce, signature: sig.replace(/^0x/, '') });
  let resp; try { resp = await skill.signInWithComputedData({ computedData: payload.computedData, chainId: CHAIN }, { sessionPrivateKey: kp.sessionPrivateKey }); }
  catch (e) { fail(`The wallet was saved to ${p}, but GDEX sign-in failed: ${String(e.message || e).slice(0, 200)}. Delete that file and run setup again.`); }
  const managed = resp && (resp.address || resp.walletAddress);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(managed))) fail(`The wallet was saved to ${p}, but GDEX did not return a trading address. Delete that file and run setup again.`);
  file.managed[CHAIN_NAME] = { chainId: CHAIN, address: managed, fund: 'USDC on Arbitrum One' };
  fs.writeFileSync(p, JSON.stringify(file, null, 2), { mode: 0o600 }); fs.chmodSync(p, 0o600);
  try { fs.writeFileSync(SESSION, JSON.stringify({ control: w.address, key: kp.sessionPrivateKey, cookie: skill.getBrowserSession(), login: Date.now(), used: Date.now() }), { mode: 0o600 }); fs.chmodSync(SESSION, 0o600); } catch { /* the next command signs in again */ }
  fs.writeFileSync(CONFIG, JSON.stringify({ address: managed }) + '\n');
  say('\n  ✓ Wallet created.');
  say('    Key file:        ' + p + '   (mode 600 - BACK THIS FILE UP. It is the only copy of your key. Never share or commit it.)');
  say('    Sign-in address: ' + w.address + '   (your identity on GDEX)');
  say('    Trading address: ' + managed + '   (holds the money; also saved to config.json)');
  fundingHelp(managed, null);
}

async function check() {
  let bad = 0; const row = (ok, name, note) => { if (!ok) bad += 1; say(`  ${ok ? '✓' : '✗'} ${name.padEnd(18)} ${note}`); };
  say('\n  DEGEN SETUP CHECK\n');
  const major = Number(process.versions.node.split('.')[0]); row(major >= 20, 'Node', process.versions.node + (major >= 20 ? '' : '  - needs 20 or newer'));
  let sdk = null; try { sdk = loadSdk(); } catch (e) { /* reported below */ }
  const need = ['hlCreateOrder', 'hlClosePosition', 'hlModifyOrder', 'hlAddPositionTpsl', 'perpDeposit'];
  const missing = sdk ? need.filter((m) => typeof sdk.SDK.GdexSkill.prototype[m] !== 'function') : [];
  row(!!sdk && !missing.length, 'GDEX SDK', sdk ? (missing.length ? `too old (no ${missing.join(', ')}) - run: npm install @gemachdao/gdex-skill@latest` : 'found (' + sdk.from + ')') : 'not found - run: npm install');
  const w = readWallet();
  row(!!(w && w.managed), 'Wallet file', w ? (w.managed ? w.path : w.path + ' has no trading address') : 'none yet - run: node setup.js');
  if (w && w.mode !== '600') row(false, 'Wallet file mode', `${w.mode} - run: chmod 600 ${w.path}`);
  let cfg = null; try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).address; } catch { /* none */ }
  const addr = process.env.DEGEN_ADDRESS || cfg || (w && w.managed);
  row(!!addr && !/YOUR/.test(addr), 'Trading address', addr && !/YOUR/.test(addr) ? addr : 'not set - run: node setup.js');
  let pw = false; for (const c of [process.env.DEGEN_PLAYWRIGHT, path.join(__dirname, 'node_modules', 'playwright'), 'playwright'].filter(Boolean)) { try { require.resolve(c); pw = true; break; } catch { /* next */ } }
  say(`  ${pw ? '✓' : '·'} ${'Chart images'.padEnd(18)} ${pw ? 'Playwright found' : 'optional - run: npm run charts   (text tools work without it)'}`);
  const mk = await hl({ type: 'meta' }); row(!!mk, 'HyperLiquid data', mk ? `reachable, ${mk.universe.length} main markets` : 'no answer - check the network, or wait if rate-limited');
  if (addr && !/YOUR/.test(addr)) {
    const b = await balances(addr);
    say('\n  MONEY');
    say(`    Deposit address (Arbitrum):  ${usd(b.arbUsdc)} USDC${b.arbEth == null ? '' : `, ${b.arbEth.toFixed(5)} ETH for gas`}`);
    say(`    HyperLiquid account:         ${usd(b.hl)}   <- what the harness trades with`);
    if (b.hl != null && b.hl < 11) { if (b.arbUsdc != null && b.arbUsdc >= 10.1) say(`\n  Next: node setup.js deposit --amount ${Math.floor(b.arbUsdc / 1.01)}`); else fundingHelp(addr, null); }
    else if (b.hl != null) say('\n  Funded. Next: node degen.js status   or tell Claude "show me the action".');
  }
  say(bad ? `\n  ${bad} thing${bad > 1 ? 's' : ''} to fix above.\n` : '\n  All good.\n'); process.exit(bad ? 1 : 0);
}

// Copy the skill into ~/.claude/skills/degen with this folder's path written in, so Claude finds the tools from anywhere.
function claude() {
  const os = require('node:os');
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'skills', 'degen'); const dest = path.join(dir, 'SKILL.md');
  const src = fs.readFileSync(path.join(__dirname, 'skills', 'degen', 'SKILL.md'), 'utf8');
  if (!/^HARNESS_DIR:.*$/m.test(src)) fail('skills/degen/SKILL.md has no HARNESS_DIR line');
  let st = null; try { st = fs.lstatSync(dir); } catch { /* not there yet */ }
  if (st && st.isSymbolicLink()) fs.unlinkSync(dir); // an old link into this repo: replace the link, never write through it
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, src.replace(/^HARNESS_DIR:.*$/m, 'HARNESS_DIR: ' + __dirname));
  say('\n  ✓ Skill installed: ' + dest);
  say('    Start Claude Code in any folder and say "show me the action", or type /degen.');
  say('    Run this again after "git pull" to pick up changes.\n');
  say('  OPTIONAL, in ~/.claude/settings.json:');
  say('    Status line (equity and open P&L):');
  say('      "statusLine": { "type": "command", "command": "node ' + path.join(__dirname, 'statusline.js') + '" }');
  say('    Let Claude run the read-only tools without asking each time ("permissions" -> "allow"):');
  for (const t of ['scan', 'sectors', 'mom', 'levels', 'vol3d', 'track', 'scope', 'shot', 'pos', 'stats']) say('      "Bash(node ' + path.join(__dirname, t + '.js') + ':*)",');
  say('    Leave degen.js and setup.js off that list unless you want orders placed without a prompt.\n');
}

async function money(cmd) {
  const amt = Number(args.amount); if (!(amt > 0)) fail(`${cmd} needs --amount N (in USDC)`);
  const w = readWallet(); if (!w || !w.managed) fail('no wallet yet - run: node setup.js');
  const b = await balances(w.managed); const dry = !!args.dry;
  if (cmd === 'deposit') {
    if (amt < 10) fail('the smallest deposit is 10 USDC');
    if (b.arbUsdc == null) fail('could not read the Arbitrum balance - try again in a moment');
    if (b.arbUsdc < amt * 1.01) fail(`the deposit address holds ${usd(b.arbUsdc)} USDC on Arbitrum; a ${amt} deposit needs ${(amt * 1.01).toFixed(2)} (1% buffer). Most you can move now: ${Math.max(0, Math.floor(b.arbUsdc / 1.01))}.`);
    say(`\n  Deposit ${amt} USDC: Arbitrum deposit address -> HyperLiquid account. Takes about 10 minutes.`);
  } else if (cmd === 'withdraw') {
    if (!Number.isInteger(amt * 10)) fail('use at most one decimal place');
    if (b.hl != null && amt > b.hl) fail(`the HyperLiquid account holds ${usd(b.hl)}`);
    say(`\n  Withdraw ${amt} USDC: HyperLiquid account -> your deposit address on Arbitrum. HyperLiquid keeps a $1 fee. Takes a few minutes.`);
  } else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(args.to))) fail('send needs --to 0x... (an Arbitrum address you control)');
    if (b.arbUsdc == null) fail('could not read the Arbitrum balance - try again in a moment');
    if (amt > b.arbUsdc) fail(`the deposit address holds ${usd(b.arbUsdc)} USDC on Arbitrum. To take money out of HyperLiquid first: node setup.js withdraw --amount N`);
    say(`\n  Send ${amt} USDC on Arbitrum: deposit address -> ${args.to}. This cannot be undone; check the address.`);
  }
  if (dry) { say('  (dry run: nothing was sent)\n'); return; }
  const { signedCall, loadWallet } = require('./degen.js'); const { SDK } = loadSdk(); const wallet = loadWallet();
  const res = await signedCall(wallet, (skill, creds) => {
    if (cmd === 'deposit') return skill.perpDeposit({ amount: String(amt), tokenAddress: USDC, chainId: CHAIN, ...creds });
    if (cmd === 'withdraw') return skill.perpWithdraw({ amount: String(amt), ...creds });
    return skill.transferToken({ recipient: args.to, tokenAddress: USDC, amount: SDK.parseAmountUnits ? SDK.parseAmountUnits(String(amt), 6, 'amount').toString() : String(Math.round(amt * 1e6)), chainId: CHAIN, managed: { apiKey: creds.apiKey, walletAddress: creds.walletAddress, sessionPrivateKey: creds.sessionPrivateKey, userId: creds.walletAddress } });
  });
  const ok = res && res.isSuccess !== false && !res.error;
  try { fs.appendFileSync(path.join(__dirname, 'journal.jsonl'), JSON.stringify({ t: new Date().toISOString(), ok, action: cmd, amount: amt, to: args.to, res }) + '\n'); } catch { /* journal is best effort */ }
  if (ok) say(`  ✓ Sent. ${cmd === 'deposit' ? 'It shows up on HyperLiquid in about 10 minutes.' : 'Give it a few minutes.'} Then: node setup.js check\n`);
  else { say('  ✗ GDEX answered with an error: ' + String((res && (res.error || res.message)) || JSON.stringify(res)).slice(0, 300)); say('    A money move can still have gone through after an error. Run "node setup.js check" in a few minutes and compare the balances BEFORE trying again.\n'); process.exit(1); }
}

(async () => {
  const cmd = args._[0] || 'init';
  if (cmd === 'init') return init();
  if (cmd === 'check') return check();
  if (cmd === 'claude') return claude();
  if (['deposit', 'withdraw', 'send'].includes(cmd)) return money(cmd);
  say('commands: (none) | check | claude | deposit --amount N | withdraw --amount N | send --to 0x.. --amount N   [--dry]');
})().catch((e) => fail(String(e.message || e)));
