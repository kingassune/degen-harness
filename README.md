// GEMACH

# Degen

A terminal trading harness for HyperLiquid perps through GDEX, built to be driven by talking to Claude Code.
It scans every perp market, shows momentum, levels and volume structure, sizes trades from a stop, places orders with the stop and
target attached, and lets you move them in one line.

It is a set of plain Node scripts. No build step, no dependencies beyond Node 20+ for the read-only tools.

> This trades real money at high leverage. Most leveraged traders lose. Nothing here is a signal that has been shown to make money:
> the replays in `research/FINDINGS.md` found no rule with a proven edge after fees. Use it to see and act faster, and judge it on
> your own scorecard (`stats.js`).

## Tools

| Tool | What it shows | Command |
|---|---|---|
| Scanner | What is moving hardest | `node scan.js` |
| Sectors | The whole board by sector | `node sectors.js` |
| Momentum | Candles and push by timeframe, or a hunt across markets | `node mom.js BTC` / `node mom.js --hunt` |
| Levels | Zones and where a stop lands, in % of margin | `node levels.js BTC` |
| 3-D terrain | Volume walls and air pockets | `node vol3d.js BTC` |
| Tracker | Radar-style read: chop, trend or turning | `node track.js BTC` |
| Scope | All of the above on one market, with chart images | `node scope.js BTC` |
| Positions | What you hold and what you are up | `node pos.js` |
| Scorecard | Your closed trades against the break-even line | `node stats.js` |
| Replay | Level setups on history, with and without the tracker | `node replay.js` |
| Orders | Fire, limit, move stops, close | `node degen.js ...` |

Add `--no-color` or `--json` to most tools.

## Orders

Stops and targets are percent of margin, the way gdex.pro shows them.

```
node degen.js plan  --coin BTC --side long --sl 20 --tp 60 --margin 40 --lev half     # numbers only
node degen.js fire  --coin BTC --side long --sl 20 --tp 60 --margin 40 --lev half     # LIVE, market entry
node degen.js fire  ... --limit 60200                                                  # LIVE, resting limit entry
node degen.js fire  ... --margin-pct 20                                                # size from the live account
node degen.js sl    --coin BTC --be            # stop to breakeven        (--lock 30, --pct 10, --to PX)
node degen.js tp    --coin BTC --pct 150       # extend the target        (--to PX, --off)
node degen.js move  --coin BTC --lock 30 --tp-pct 200
node degen.js flat  --coin BTC
```

Rails (change with environment variables):

| Rail | Default | Variable |
|---|---|---|
| Dollars risked per trade | $30 | `DEGEN_MAX_RISK_USD` |
| Open plus resting risk, % of equity | 25% | `DEGEN_MAX_RISK_PCT` |
| Drawdown floor for percent sizing | 30% under the peak | `DEGEN_DD_FLOOR` |
| Stop must sit inside the distance to liquidation | 70% | fixed |

## Setup

1. **Node 20 or newer.**
2. **Your public address**, for the read-only tools: copy `config.example.json` to `config.json` and put your HyperLiquid address in it
   (or set `DEGEN_ADDRESS`).
3. **To place orders:** the GDEX SDK and a GDEX managed wallet file.
   - `GDEX_SKILL_DIR` = a checkout of `@gemachdao/gdex-skill` with `dist/` built (default: `../gdex-skill`).
   - `GCLAW_WALLET` = the wallet JSON (default: `../gdex-test-wallet.json`). It holds a private key. Keep it out of git and mode 600.
4. **Chart images (optional):** `npm i playwright && npx playwright install chromium`, or point `DEGEN_PLAYWRIGHT` at an existing install.

Files the harness writes and git ignores: `.session.json` (GDEX session, secret), `.equity.json` (peak equity), `journal.jsonl`
(every live action), `out/` (charts).

## Claude Code

- `skills/degen/SKILL.md` teaches Claude the tools. Link it into `~/.claude/skills/degen`, or install this folder as a plugin.
- Status line: `"statusLine": { "type": "command", "command": "node /path/to/degen/statusline.js" }` in `settings.json`.
- To let Claude place orders without a prompt each time, add the permission rule `Bash(node /path/to/degen/degen.js:*)` yourself.

## How the calls line up with gdex.pro

The order engine sends the same back-end calls as the gdex.pro perp page (checked against the front-end and back-end code, 2026-11-20).

| Action | Call | Notes |
|---|---|---|
| Open at market | `create_order`, `isMarket` true, price = mark | The back-end adds its own 5% slippage bound. Leverage rides on the order. |
| Open with a limit | `create_order`, `isMarket` false | Must be below the mark for a long, above for a short, or it is refused. |
| Stop and target at entry | `tpPrice` / `slPrice` on `create_order` | Both together. Percent is percent of margin: `price x (1 +/- pct / leverage / 100)`. Market triggers. |
| Move a stop or target | `modify_order` with the new trigger price | |
| Add a stop or target to a position | `add_position_tpsl` with the full position size | |
| Remove a target, cancel an entry | `cancel_order` | |
| Close | `place_order`, reduce-only | The site's close button. It closes at market and ignores the price given. |
| Resting take-profit | `create_order`, reduce-only, `isMarket` false | The site's limit close. `tp --maker`. |

Margin mode is the back-end's choice: main markets are cross, every `dex:` market is isolated.
Moving a resting entry's price (`entry --to`) uses `modify_order` too; the site has no button for that.

## Fees

Measured on live fills: 0.0932% of position per side at market (HyperLiquid 0.0432% + GDEX builder 0.05%).
A round trip costs 7.5% of margin at 40x and 3.7% at 20x. `plan` shows the fee as a percent of margin and the win rate needed to break even.

## Research

`research/FINDINGS.md` lists what was taken from the literature (with arXiv links), what was built from it, and the replay results.

## Licence

Not chosen yet.
