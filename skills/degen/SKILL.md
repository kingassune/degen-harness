---
name: degen
description: Drive the Degen perp trading harness (HyperLiquid through GDEX) by talking. Use for "show me the action", "scope <market>", "levels on X", "3D on X", "what am I up", "long/short X", "limit at", "move my stop", "stop to breakeven", "extend the target", "close it", "how am I doing", "set me up", "fund my account", sectors, momentum, tracker, or any perp trade on this account.
---

# Degen harness

HARNESS_DIR: (not recorded: use the folder that holds `degen.js`. When Claude is started inside the repo, that is the working directory.)

Run every tool as `node <HARNESS_DIR>/<tool>.js`. Everything is read-only except `degen.js fire|flat|cancel|entry|sl|tp|move` and
`setup.js deposit|withdraw|send`, which move real money.

## First run

Run `setup.js check` when the user is new, when a tool says there is no wallet or address, or when they ask "am I set up".

| The user says | Run |
|---|---|
| "set me up", "get me started" | `npm install` in the harness folder if the SDK is missing, then `setup.js` (creates the wallet once, prints the deposit address) |
| "am I set up", "where's my money" | `setup.js check` |
| "how do I fund it" | `setup.js` (prints the address and steps again; changes nothing) |
| "move my deposit in", "deposit 50" | `setup.js deposit --amount 50` — USDC from the deposit address on Arbitrum into HyperLiquid, about 10 minutes |
| "take 50 out" | `setup.js withdraw --amount 50` (HyperLiquid to the deposit address, $1 exchange fee), then `setup.js send --to 0x... --amount N` |

Funding facts: the user sends **USDC on Arbitrum One** to the deposit address, at least $11. The smallest deposit is $10 and the
deposit address must hold the amount plus 1%. If a money move reports an error, run `setup.js check` and compare balances before
any retry: a move can go through after an error. Before `send`, read the destination address back to the user and get a yes.
Tell the user to back up the key file (`~/.degen/wallet.json`). Never open, print or paste it.

## Map requests to tools

| The user says | Run |
|---|---|
| "show me the action", "what's moving" | `sectors.js`, `scan.js --top 12`, `mom.js --hunt --top 12`, `pos.js` |
| "show me X", "scope X", "let me see X" | `scope.js X` — then show the three PNGs and the interactive 3-D HTML. Always both the momentum chart and the 3-D terrain. |
| "levels on X", "where does my stop go" | `levels.js X [--budget PCT]` |
| "3D on X" | `vol3d.js X` then `shot.js out/X-3d.html`, show PNG + HTML |
| "track X", "is it chop or trending" | `track.js X [--tf 5m] [--png]` |
| "what am I up", "positions" | `pos.js` |
| "how am I doing", "scorecard" | `stats.js [--days N]` |
| "sector X" | `sectors.js --sector X` |
| "watch it" | `/loop 2m` with `pos.js`, report only changes that matter (stop or target hit, P&L swing, liquidation near) |

Markets on builder venues are `dex:ASSET` with a lowercase prefix (`xyz:NVDA`, `xyz:SP500`). If a ticker is not found, search loosely
across venues by volume before answering; never guess the venue.

Chart images need Playwright (`npm run charts` once). Without it, `scope.js X --no-png` still gives every read-out as text.
If a tool says HyperLiquid did not answer, wait about 10 seconds and run it again; do not loop.

## Trading (live money)

Stops and targets are PERCENT OF MARGIN, the way gdex.pro shows them, or prices.

```
degen.js plan  --coin X --side long|short --stop PX --tp-px PX --lev half|max|N           # numbers only, nothing sent
degen.js plan  --coin X --side long|short --sl 20 --tp 60 --margin 40 --lev half|max|N    # same, in percent of margin
degen.js fire  ...same...                         # market entry, stop and target attached
degen.js fire  ... --limit PX                     # resting limit entry, stop and target attached
degen.js fire  ... (no size flag)                 # DEFAULT SIZE: 80% of the live account as margin
degen.js fire  ... --margin-pct 20                # any other share of the live account (--margin N for dollars)
degen.js sl    --coin X --be | --lock 30 | --pct 10 | --to PX
degen.js tp    --coin X --pct 150 | --to PX | --off
degen.js move  --coin X --lock 30 --tp-pct 200    # stop and target together
degen.js entry --coin X --to PX                   # move a resting limit
degen.js cancel --coin X                          # resting entries only
degen.js flat  [--coin X]                         # close
degen.js orders | status | peak [--reset]
```

Rules:
1. Before any `fire`, run `plan` and state in one or two lines what will be spent: margin, leverage, dollars lost if the stop is hit (and what share of the account that is), the fee in dollars, and every warning. Then fire if the user has asked for the trade. A plain "long X" with the details given is the ask; do not make them repeat it.
2. Adjusts (`sl`, `tp`, `move`, `entry`, `cancel`, `flat`) on the user's own position: run them straight away when asked, then report old -> new. Speed matters. Use `--dry` only when the user asks for a preview.
3. After any live action show the result with `pos.js`. If a command reports `ok: false`, say so first and say what is still live.
4. Never remove a stop (`sl --off` is refused without an override). Never touch positions the harness did not open unless told to.
5. Never print the wallet file, keys or `.session.json`. Read-only tools use the public address in `config.json`.
6. In chat, terminal colours do not show: use 🟢 🔴 🟡 and plain tables. Lead with the call, then the numbers.
7. The user's read decides the trade. The tools measure; they do not predict. Do not present any read-out as a signal that "works", and do not lecture about size once the numbers in rule 1 have been stated.

## Facts that change decisions

- Stops and targets come from ZONES, not fixed percents: the stop goes beyond the zone that would prove the trade wrong, wide enough to survive the swing, so it may be 20% or 30% of margin or more. Run `levels.js X`, propose the zone-based stop and target as prices, and send them with `--stop PX --tp-px PX`. Report what that is in % of margin; never shrink the stop to hit a round percent.
- Size: with no size flag, `fire` uses 80% of the account as margin (`DEGEN_DEFAULT_MARGIN_PCT` changes it). There are no size caps unless the user set `DEGEN_MAX_RISK_USD`, `DEGEN_MAX_RISK_PCT` or `DEGEN_DD_FLOOR`. At 80% of the account, a stop that costs 20% of margin loses about 16% of the account plus fees. Say that number in the pre-fire line.
- `plan` refuses a stop further than 70% of the way to liquidation: the position would be liquidated before the stop could work. Lower the leverage or tighten the stop.
- Fees per side, share of position: the GDEX builder fee is 0.05% on every perp market. HyperLiquid adds its own: 0.0432% on main markets (total 0.0932%), 0.0086% measured on `xyz:` stock markets (total 0.0586%). Quote the fee as a percent of position and in dollars, and say which part is GDEX; do not quote it as a percent of margin without saying leverage multiplies it.
- When the stop is so close that round-trip fees pass a quarter of the risk, `plan` warns (about 0.75% of price on main markets, 0.47% on `xyz:` markets).
- Margin mode is set by the back-end: main markets (BTC, ETH, SOL...) are CROSS, backed by the whole account. Any `dex:` market (`xyz:NVDA`, `xyz:SP500`...) is ISOLATED: its own margin and its own liquidation price.
- Leverage rides on the order (`--lev`), as on gdex.pro, whose default is the market's max. If the exchange refuses the change the order still goes at the old setting; `fire` warns when the fill's leverage differs. Size and stop prices are right either way.
- A limit entry must be below the mark for a long and above it for a short, or GDEX refuses it.
- GDEX allows 10 sign-ins per 15 minutes; the harness reuses one saved session. If "Too many sign-in attempts" appears, wait for the window; do not retry in a loop. Signing in to gdex.pro with the same wallet signs the harness out (it signs back in on the next command).
- A resting take-profit limit works with `tp --coin X --pct N --maker`. Never use the SDK `hlPlaceOrder` for it: that endpoint closes the position at market.
- Replays so far (`track.js --backtest-all`, `replay.js`) found no rule with a proven edge after fees.
- Stock-linked markets trade around the clock but are thin when US markets are closed.
