# Research findings for the harness (arXiv pass, 2026-11-20)

Search: adaptive, 52 live queries, 200 relevant papers across 6 topics. Query lineage and full lists are in
`LITERATURE.md`; abstracts are in `corpus.jsonl`. Every claim below is taken from the paper's abstract only.
The corpus is a snapshot from 2026-10-10. Status: **built** = in the tools now, **next** = planned, **note** = guidance.

## Levels

| Finding | Paper | What it means for us | Status |
|---|---|---|---|
| Intraday support/resistance levels reverse price significantly more than chance. More earlier bounces means a level is more likely to hold again. The chance of a bounce fades with time. | [2101.07410](https://arxiv.org/abs/2101.07410) | Score zones by number of touches and by freshness. | **built**: `levels.js` halves a touch's weight every 30 candles |
| Round numbers attract more resting liquidity, but once you adjust for that depth, price does not stay there longer (five Nasdaq stocks, 2025). | [2610.34787](https://arxiv.org/abs/2610.34787) | Do not treat a round number as a level by itself. Use traded levels and volume walls. | note |

## Liquidation cascades

| Finding | Paper | What it means for us | Status |
|---|---|---|---|
| In the October 2025 crash, 88% of forced selling landed within 30 minutes of onset and 63% was absorbed off-book. At onset, coupling between assets jumps 1.6–4.4 standard deviations (seven cascades, 2022–2025). | [2608.03616](https://arxiv.org/abs/2608.03616) | A cascade is short. Detect onset by "everything moving together", and treat the first 30 minutes as the forced-selling window. | next: coupling gauge in `scan.js` |
| No early-warning signal works across all seven cascades. Price shows a warning in five, and none in the two sudden-news shocks. | [2607.27070](https://arxiv.org/abs/2607.27070) | Do not build a cascade predictor. Build a fast detector and react. | note |
| On BitMEX, liquidated traders averaged 60x. Holding the daily margin-call chance to 1% needs about 3x for longs and 5x for shorts. Assuming normal returns understates this. | [2102.04591](https://arxiv.org/abs/2102.04591) | Max leverage cannot survive a day of normal movement. These are short-hold trades: stop first, and a time limit. | next: time stop in `degen.js` |

## Stops and exits

| Finding | Paper | What it means for us | Status |
|---|---|---|---|
| Replaying 900+ crypto trades under many exit rules: exit design matters, and tighter loss limits, earlier profit-taking and closer trailing did better. One system, randomised split. | [2604.27150](https://arxiv.org/abs/2604.27150) | Supports tight stops, weakly. The method is the useful part: replay our own journal under other exits. | next: exit replay over `journal.jsonl` |
| Stop levels are usually arbitrary. Choose them from the distribution of drawdowns instead. | [1609.00869](https://arxiv.org/abs/1609.00869) | Measure how far price normally moves against a trade before picking the stop %. | **built** (first step): `degen.js plan` warns when the stop is inside one average 15m candle |
| With a trailing stop, the best exit is a sell limit order used together with the trailing stop. | [1701.03960](https://arxiv.org/abs/1701.03960) | Keep the fixed target order when trailing is added. | next: `trail` command |

## Sizing

| Finding | Paper | What it means for us | Status |
|---|---|---|---|
| Long-run growth has an optimal leverage. Past it, growth falls even when the average return looks better. | [0902.2965](https://arxiv.org/abs/0902.2965) | Dollars at risk per trade is the real dial, not the leverage number. The harness already sizes from risk. | built (design) |
| In prop-firm evaluations, position sizing alone passes about 40% of the time with zero skill. | [2609.14859](https://arxiv.org/abs/2609.14859) | A hot streak at high leverage is not proof of edge. Judge the system on the journal, over many trades. | next: stats over `journal.jsonl` |

## Volatility timing

| Finding | Paper | What it means for us | Status |
|---|---|---|---|
| Crypto activity has three daily phases (Asia, Europe, US), bursts at full hours and 15-minute marks, and bursts at US macro releases. | [2306.17095](https://arxiv.org/abs/2306.17095) | Expect stop-hunting moves on the hour and at data releases. | built (partly): `vol3d.js` shows volatility by hour; next: release calendar warning |
| Past realized variance raises future variance. Jumps, especially upward ones, lower it. | [1912.05228](https://arxiv.org/abs/1912.05228) | After a wild hour expect more of the same; widen the breathing room. | next: scale the stop buffer by recent heat |

## Contagion

| Finding | Paper | What it means for us | Status |
|---|---|---|---|
| In crashes, the 13 largest coins behave as one block anchored on BTC and ETH. Rallies are less linked. | [2606.16840](https://arxiv.org/abs/2606.16840) | Three crypto shorts in a selloff are one bet, not three. | next: count same-direction crypto risk as one position |
| BTC correlation with the Nasdaq 100 and S&P 500 rose with ETF adoption, peaking at 0.87 in 2024. | [2501.09911](https://arxiv.org/abs/2501.09911) | A BTC short and an NVDA short overlap too. | next: same rule across stock perps |

## Gaps

- No paper in the corpus tested volume-at-price walls directly. The `vol3d.js` walls rest on the level papers above, by analogy.
- Funding rate and open interest as trade signals: the corpus had mechanics and design papers, not tested signals.

---

# Tracker pass (arXiv, 2026-11-22): radar-style trajectory tracking on price

Search: adaptive, 42 live queries, 164 relevant papers across 5 topics (`track/LITERATURE.md`, `track/corpus.jsonl`). Claims are from abstracts only.

## Tracking methods

| Finding | Paper | What it means for us | Status |
|---|---|---|---|
| The interacting multiple model (IMM) filter is the standard way to track a maneuvering aircraft: several motion models run at once and the data weights them. | [2409.13782](https://arxiv.org/abs/2409.13782) | Use it as the tracker: hover / cruise / maneuver on log price. | **built**: `track.js` |
| Blending models lags during a maneuver; switching to the winning model reacts faster but jumps. | [2511.20294](https://arxiv.org/abs/2511.20294) | Expect the track to be late at turns. Read the "surprise" value, not only the mode. | note |
| A fixed model-switching matrix must be tuned blind; adapting it from inside the filter can feed back on itself. Driving it from the normalized innovation is proposed instead. | [2610.11242](https://arxiv.org/abs/2610.11242) | Our 94% stay-probability is a guess. | next: innovation-driven switching |
| Maneuver acceleration can be modelled with GARCH volatility, borrowed from finance. | [1902.04671](https://arxiv.org/abs/1902.04671) | The two fields already share tools. Our running sigma is the simple version. | built (simple form) |

## Kalman filters in trading

| Finding | Paper | What it means for us | Status |
|---|---|---|---|
| Published Kalman trading results are mostly pairs trading: the filter tracks the spread between two related assets and bands trigger the trades. | [2210.15448](https://arxiv.org/abs/2210.15448), [2302.05993](https://arxiv.org/abs/2302.05993) | The evidence is for spreads, not for one price alone. | next: tracker on a spread (e.g. two venues of one stock, ETH/BTC) |
| When price is mean reverting, the best limit prices stay fixed and do not follow price. | [1607.00454](https://arxiv.org/abs/1607.00454) | In chop, rest limits at levels (zones, walls), not at a band that moves with price. | note: matches the `levels.js` + `--limit` workflow |
| Transaction costs change when it is worth entering and leaving a mean-reverting market. | [1605.07945](https://arxiv.org/abs/1605.07945) | Fees decide whether chop is tradable at all. | measured below |

## Compounding

| Finding | Paper | What it means for us | Status |
|---|---|---|---|
| What compounds is the expected log return, not the average return; volatility drags it down. | [2610.39097](https://arxiv.org/abs/2610.39097), [0902.2965](https://arxiv.org/abs/0902.2965) | Size as a percent of the account, and judge by growth of the account. | **built**: `--margin-pct` / `--risk-pct` |
| Fractional Kelly: betting a fraction of the growth-optimal size trades growth for smaller drawdowns. | [2109.10814](https://arxiv.org/abs/2109.10814) | With an unproven edge, bet well under what looks optimal. | note |
| With trading costs, the growth-optimal policy trades less: hold inside a band rather than adjust constantly. | [cond-mat/0211044](https://arxiv.org/abs/cond-mat/0211044) | Fewer, better trades. Each round trip at 40x costs 7.5% of margin. | **built**: `plan` shows fee % of margin and break-even win rate |
| Scaling position size by distance from a drawdown floor guarantees the floor is never crossed. | [1710.01503](https://arxiv.org/abs/1710.01503) | A drawdown brake for the compounding account. | next: drawdown brake |

## Our own replay (not from a paper)

`node track.js --backtest-all`: 8 markets x 5m/15m/1h, up to 5,000 candles each, entries at the next candle's open, stop checked before target,
fees as measured on this account's fills (0.0932% per side at market; 0.065% assumed for resting limits).

| Rule | Trades | Win rate | Average before fees | Average after fees | Verdict |
|---|---|---|---|---|---|
| Rest limits at the chop band, target the track | 2,574 | 43% | -0.050% | -0.197% | loses, even before fees |
| Fade a surprise while hovering (market order) | 13 | 85% | +0.251% | +0.065% | too few trades to mean anything |
| Ride a fresh lock, exit when lock is lost | 345 | 29% | +0.145% | -0.041% | small gross edge, not significant, gone after fees |

The tracker is a measuring instrument (mode, velocity, lock, surprise). Traded mechanically on one price, it has no edge after fees in this replay.
The filter settings were fixed in advance and not tuned on this data.

## Level setups with the tracker as a filter (`replay.js`, 2026-11-22)

8 markets, zones rebuilt from the past only at every candle, target = 3 x risk, real fees. Setups whose stop is under 0.75% of price are
skipped, because below that the fees are over a quarter of the amount risked. R = result as a multiple of the amount risked.

| Setup (15m candles, 333 market-days) | Trades | Hit target | R before fees | R after fees | t |
|---|---|---|---|---|---|
| Every fade at a zone | 216 | 27% | +0.085 | -0.087 | -0.7 |
| Fade, tracker says chop | 21 | 33% | +0.443 | +0.279 | 0.7 |
| Every breakout through a zone | 451 | 26% | +0.175 | +0.014 | 0.2 |
| Breakout, tracker locked with it | 89 | 25% | +0.286 | +0.146 | 0.8 |
| Breakout, surprise 2+ sigma with it | 211 | 27% | +0.246 | +0.098 | 0.8 |
| Breakout, no lock and no surprise | 216 | 27% | +0.141 | -0.033 | -0.3 |

- On 5m the same ordering holds for breakouts (+0.044 and +0.068 with the tracker, -0.249 without). On 1h every variant is negative (-0.14 to -0.26).
- No row is statistically solid (all |t| under 1 on 15m). Eight filters were tried, so some looking good by luck is expected.
- Without the 0.75% minimum stop, fades average -1.13 R: zones are tight (0.30% average stop), so fees are about half the risk on every trade.

## Fee cut attempt (live, 2026-11-22)

| Idea | Result |
|---|---|
| Rest the entry at the top of the book | GDEX checks the price against its own mark, which lagged the real one (60,699 vs 60,726). The order rested about 0.06% under the market and did not fill in 2 minutes. Now opt-in: `--join`. |
| Take profit as a resting limit | GDEX's reduce-only `place_order` closed the position at market instead of resting. Disabled. |
| The builder fee | 0.05% of the 0.0932% per side is the GDEX builder fee. That is the largest lever and it is a company decision. |
