---
name: degen
description: Drive the Degen perp trading harness (HyperLiquid through GDEX) by talking. Use for "show me the action", "scope <market>", "levels on X", "3D on X", "what am I up", "long/short X", "limit at", "move my stop", "stop to breakeven", "extend the target", "close it", "how am I doing", sectors, momentum, tracker, or any perp trade on this account.
---

# Degen harness

Tools live in the harness folder (this skill's `../..`, e.g. `~assune/degen`). Run them with `node <folder>/<tool>.js`.
Everything except `degen.js fire|flat|cancel|entry|sl|tp|move` is read-only.

## Map requests to tools

| The user says | Run |
|---|---|
| "show me the action", "what's moving" | `sectors.js`, `scan.js --top 12`, `mom.js --hunt --top 12`, `pos.js` |
| "show me X", "scope X", "let me see X" | `scope.js X` — then SEND the three PNGs and the interactive 3-D HTML. Always both the momentum chart and the 3-D terrain. |
| "levels on X", "where does my stop go" | `levels.js X [--budget PCT]` |
| "3D on X" | `vol3d.js X` then `shot.js out/X-3d.html`, send PNG + HTML |
| "track X", "is it chop or trending" | `track.js X [--tf 5m] [--png]` |
| "what am I up", "positions" | `pos.js` |
| "how am I doing", "scorecard" | `stats.js [--days N]` |
| "sector X" | `sectors.js --sector X` |
| "watch it" | `/loop 2m` with `pos.js`, report only changes that matter (stop or target hit, P&L swing, liquidation near) |

Markets on builder venues are `dex:ASSET` with a lowercase prefix (`xyz:NVDA`, `xyz:ANT`). If a ticker is not found, search loosely
across venues by volume before answering; never guess the venue.

## Trading (live money)

Stops and targets are PERCENT OF MARGIN, the way gdex.pro shows them. Style: half-max or max leverage, tight stops at levels.

```
degen.js plan  --coin X --side long|short --sl 20 --tp 60 --margin 40 --lev half|max|N     # numbers only, nothing sent
degen.js fire  ...same...                         # market entry, stop and target attached
degen.js fire  ... --limit PX                     # resting limit entry, stop and target attached
degen.js fire  ... --margin-pct 20                # size from the live account (compounding); drawdown brake applies
degen.js sl    --coin X --be | --lock 30 | --pct 10 | --to PX
degen.js tp    --coin X --pct 150 | --to PX | --off
degen.js move  --coin X --lock 30 --tp-pct 200    # stop and target together
degen.js entry --coin X --to PX                   # move a resting limit
degen.js cancel --coin X                          # resting entries only
degen.js flat  [--coin X]                         # close
degen.js orders | status | peak [--reset]
```

Rules:
1. Before any `fire`, run `plan` and state in one or two lines what will be spent: margin, leverage, dollars risked, fee as % of margin, break-even win rate, and every warning. Then fire if the user has asked for the trade. A plain "long X" with sizes given is the ask; do not make them repeat it.
2. Adjusts (`sl`, `tp`, `move`, `entry`, `cancel`, `flat`) on the user's own position: run them straight away when asked, then report old -> new. Speed matters. Use `--dry` only when the user asks for a preview.
3. After any live action show the result with `pos.js`. If a command reports `ok: false`, say so first and say what is still live.
4. Never remove a stop (`sl --off` is refused without an override). Never touch positions the harness did not open unless told to.
5. Never print the wallet file, keys or `.session.json`. Read-only tools use the public address in `config.json`.
6. In chat, terminal colours do not show: use 🟢 🔴 🟡 and plain tables. Lead with the call, then the numbers.

## Facts that change decisions

- Fees: 0.0932% of position per side at market (HyperLiquid 0.0432% + GDEX builder 0.05%). A round trip costs 7.5% of margin at 40x, 3.7% at 20x.
- A stop closer than 0.75% of price means fees are over a quarter of the risk. `plan` warns. At 40x that is a 30% margin stop.
- Margin mode is set by the back-end, not by us: main markets (BTC, ETH, SOL...) are CROSS, backed by the whole account. Any `dex:` market (`xyz:NVDA`, `xyz:ANT`...) is ISOLATED: its own margin and its own liquidation price.
- Leverage rides on the order (`--lev`), as on gdex.pro, whose default is the market's max. If the exchange refuses the change the order still goes at the old setting; `fire` warns when the fill's leverage differs. Size and stop prices are right either way.
- The harness sends the same calls as gdex.pro: open = create_order (market sends the mark price), stop/target edits = modify_order / add_position_tpsl / cancel_order, close = place_order, limit close = create_order with reduce-only. A limit entry must be below the mark for a long and above it for a short, or GDEX refuses it.
- GDEX allows 10 sign-ins per 15 minutes; the harness reuses one saved session. If "Too many sign-in attempts" appears, wait for the window; do not retry in a loop.
- A resting take-profit limit works with `tp --coin X --pct N --maker` (lower fee when it fills). Never use the SDK `hlPlaceOrder` for it: that endpoint closes the position at market.
- Replays so far (`track.js --backtest-all`, `replay.js`) found no rule with a proven edge after fees. Breakouts the tracker confirms did best. The tools measure; they do not predict. Do not present any read-out as a signal that "works".
- Stock-linked markets trade around the clock but are thin when US markets are closed.
