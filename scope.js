#!/usr/bin/env node
/**
 * SCOPE — everything on one target in one go. Read-only.
 *
 *   node scope.js xyz:ANT            # momentum, levels and tracker read-outs + three chart PNGs in out/
 *   node scope.js BTC --no-png       # text only
 *
 * Charts written: out/<coin>-mom.png (candles and momentum), out/<coin>-3d.png (+ .html, volume terrain), out/<coin>-track.png (tracker).
 */
'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
const coin = argv.find((a) => !a.startsWith('--'));
if (!coin) { console.log('usage: scope.js <COIN> [--no-png] [--no-color]'); process.exit(1); }
const png = !argv.includes('--no-png'); const color = argv.includes('--no-color') ? ['--no-color'] : [];
const run = (file, args) => { try { return execFileSync(process.execPath, [path.join(__dirname, file), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env }); } catch (e) { return `(${file} failed: ${String(e.stderr || e.message).split('\n')[0]})\n`; } };
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // the public API rate-limits bursts
const i = coin.indexOf(':'); const name = i === -1 ? coin.toUpperCase() : coin.slice(0, i).toLowerCase() + ':' + coin.slice(i + 1).toUpperCase(); const stem = name.replace(':', '-');
process.stdout.write(run('mom.js', [name, ...(png ? ['--png'] : []), ...color])); wait(2500);
process.stdout.write(run('levels.js', [name, ...color])); wait(2500);
process.stdout.write(run('track.js', [name, ...(png ? ['--png'] : []), ...color]));
if (png) {
  wait(2500); run('vol3d.js', [name]);
  const files = ['mom', '3d', 'track'].map((k) => path.join(__dirname, 'out', `${stem}-${k}.html`));
  const res = run('shot.js', files);
  console.log('CHARTS'); for (const k of ['mom', '3d', 'track']) console.log('  ' + path.join(__dirname, 'out', `${stem}-${k}.png`)); console.log('  ' + path.join(__dirname, 'out', `${stem}-3d.html`) + '   (interactive)');
  if (/failed|"errs":\["/.test(res)) console.log('  render note: ' + res.trim().slice(0, 300));
}
