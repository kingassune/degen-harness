// Shared by degen.js and setup.js: where the GDEX SDK and the wallet file are found. No secrets are read or printed here.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_WALLET = path.join(os.homedir(), '.degen', 'wallet.json');
// Order: DEGEN_WALLET, GCLAW_WALLET (gdesk's name for it), ~/.degen/wallet.json, then a legacy file next to this folder.
function walletPath() {
  if (process.env.DEGEN_WALLET) return process.env.DEGEN_WALLET;
  if (process.env.GCLAW_WALLET) return process.env.GCLAW_WALLET;
  const legacy = path.join(__dirname, '..', 'gdex-test-wallet.json');
  if (!fs.existsSync(DEFAULT_WALLET) && fs.existsSync(legacy)) return legacy;
  return DEFAULT_WALLET;
}
// Order: GDEX_SKILL_DIR (a built checkout), the npm package installed here, then a built checkout next to this folder.
function loadSdk() {
  const tried = [];
  const fromDir = (dir) => ({ SDK: require(path.join(dir, 'dist')), ethers: require(path.join(dir, 'node_modules', 'ethers')).ethers, from: dir });
  if (process.env.GDEX_SKILL_DIR) return fromDir(process.env.GDEX_SKILL_DIR);
  try { return { SDK: require('@gemachdao/gdex-skill'), ethers: require('ethers').ethers, from: 'node_modules' }; } catch (e) { tried.push(String(e.message).split('\n')[0]); }
  try { return fromDir(path.join(__dirname, '..', 'gdex-skill')); } catch (e) { tried.push(String(e.message).split('\n')[0]); }
  throw new Error('GDEX SDK not found. Run "npm install" in ' + __dirname + ' (or set GDEX_SKILL_DIR to a built checkout). ' + tried.join(' | '));
}
// One plain line instead of a stack trace. The usual cause is HyperLiquid's public API answering nothing during a burst.
function bail(e) {
  const first = String((e && e.message) || e).split('\n')[0];
  if (e instanceof TypeError || /fetch failed|rate limit|did not answer/i.test(first)) console.error('Could not finish: HyperLiquid did not answer (its public API rate-limits bursts). Wait about 10 seconds and run it again.  [' + first + ']');
  else console.error(process.env.DEGEN_DEBUG ? String((e && e.stack) || e) : 'Error: ' + first + '   (set DEGEN_DEBUG=1 for the full trace)');
  process.exit(1);
}
module.exports = { walletPath, loadSdk, bail, DEFAULT_WALLET };
