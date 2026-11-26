#!/usr/bin/env node
// Offline smoke test: nothing here touches the network, a wallet or money.   node test/smoke.js
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
let n = 0; const ok = (name) => { n += 1; console.log('  ok  ' + name); };

// 1. the SDK is installed and has every call the order engine and setup use
delete process.env.GDEX_SKILL_DIR;
const { loadSdk, walletPath, DEFAULT_WALLET } = require(path.join(root, 'lib.js'));
const { SDK, ethers } = loadSdk();
for (const m of ['hlCreateOrder', 'hlClosePosition', 'hlModifyOrder', 'hlAddPositionTpsl', 'hlCancelOrder', 'perpDeposit', 'perpWithdraw', 'transferToken', 'signInWithComputedData']) assert.strictEqual(typeof SDK.GdexSkill.prototype[m], 'function', 'SDK is missing ' + m);
for (const f of ['generateEvmWallet', 'generateGdexSessionKeyPair', 'generateGdexNonce', 'buildGdexSignInMessage', 'buildGdexSignInComputedData']) assert.strictEqual(typeof SDK[f], 'function', 'SDK is missing ' + f);
assert.ok(SDK.GDEX_API_KEY_PRIMARY, 'SDK has no shared API key'); assert.strictEqual(typeof ethers.Wallet, 'function');
ok('GDEX SDK has every call the harness uses');

// 2. wallet path order: DEGEN_WALLET, GCLAW_WALLET, then the default
const keep = { a: process.env.DEGEN_WALLET, b: process.env.GCLAW_WALLET };
process.env.DEGEN_WALLET = '/x/a.json'; process.env.GCLAW_WALLET = '/x/b.json'; assert.strictEqual(walletPath(), '/x/a.json');
delete process.env.DEGEN_WALLET; assert.strictEqual(walletPath(), '/x/b.json');
delete process.env.GCLAW_WALLET; assert.ok(walletPath().endsWith('wallet.json'));
if (keep.a) process.env.DEGEN_WALLET = keep.a; if (keep.b) process.env.GCLAW_WALLET = keep.b;
assert.ok(DEFAULT_WALLET.includes('.degen'));
ok('wallet path order');

// 3. a generated wallet is well formed (nothing is saved or sent)
const w = SDK.generateEvmWallet(); assert.match(w.address, /^0x[0-9a-fA-F]{40}$/); assert.match(w.privateKey, /^0x[0-9a-f]{64}$/i);
ok('wallet generation');

// 4. the skill file has the line the installer rewrites, and the installer writes a copy with this folder in it
const skill = fs.readFileSync(path.join(root, 'skills', 'degen', 'SKILL.md'), 'utf8');
assert.match(skill, /^HARNESS_DIR:/m); assert.match(skill, /^name: degen$/m);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'degen-smoke-'));
execFileSync(process.execPath, [path.join(root, 'setup.js'), 'claude'], { env: { ...process.env, CLAUDE_CONFIG_DIR: tmp }, stdio: 'pipe' });
assert.ok(fs.readFileSync(path.join(tmp, 'skills', 'degen', 'SKILL.md'), 'utf8').includes('HARNESS_DIR: ' + root));
ok('skill install');

// 5. no wallet: the order engine says how to make one instead of crashing
const env = { ...process.env, DEGEN_WALLET: path.join(tmp, 'none.json'), DEGEN_ADDRESS: '' };
let out = ''; try { out = execFileSync(process.execPath, [path.join(root, 'degen.js'), 'fire'], { env, stdio: 'pipe', encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
assert.match(out, /setup\.js/); ok('missing wallet is explained');

// 6. every doc image the README and docs point at exists
for (const f of ['README.md', ...fs.readdirSync(path.join(root, 'docs')).filter((x) => x.endsWith('.md')).map((x) => 'docs/' + x)]) {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of text.matchAll(/(?:src="|\]\()((?:\.\.\/)?(?:docs\/)?(?:img\/)?[\w./-]+\.(?:png|md|js))[")#]/g)) {
    if (/^https?:/.test(m[1])) continue; const target = path.join(root, path.dirname(f), m[1]); assert.ok(fs.existsSync(target), `${f} points at a missing file: ${m[1]}`);
  }
}
ok('doc links and images exist');
console.log(`\n${n} checks passed`);
