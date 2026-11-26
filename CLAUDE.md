# Degen harness

Plain Node scripts for trading HyperLiquid perps through GDEX. No build step. `skills/degen/SKILL.md` maps what the user says to
the tool to run; follow it for anything about markets, positions or orders.

- Read-only: `sectors.js scan.js mom.js levels.js vol3d.js track.js scope.js pos.js stats.js replay.js shot.js`, `setup.js check`,
  `degen.js plan|status|orders|peak`.
- **Live money:** `degen.js fire|flat|cancel|entry|sl|tp|move` and `setup.js deposit|withdraw|send`. Before `fire`, run `plan` and
  state margin, leverage, dollars lost at the stop, and the fee.
- Never read, print or commit `~/.degen/wallet.json`, any wallet file, or `.session.json`.
- New user: `npm install`, `node setup.js`, then `node setup.js check`. Docs are in `docs/`.
- Checks before a commit: `npm test`.
