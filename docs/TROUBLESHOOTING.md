# Troubleshooting

Start here: `node setup.js check`. It tests the install and shows where your money is.

| You see | Why | Do this |
|---|---|---|
| `GDEX SDK not found` | `npm install` has not been run in this folder | `npm install` |
| `GDEX SDK ... too old` | An SDK older than 5.5.0 | `npm install @gemachdao/gdex-skill@latest` |
| `no wallet file at ...` | No wallet yet, or `DEGEN_WALLET` points somewhere else | `node setup.js` |
| `no address: set DEGEN_ADDRESS or ...` | `config.json` is missing | `node setup.js` (it rewrites it and changes nothing else) |
| `the account has no money to trade with` | The HyperLiquid account is empty | `node setup.js check`, then fund or `deposit` |
| `position of $X is below the $11 HyperLiquid minimum` | Margin times leverage is too small | More margin or more leverage |
| `Could not finish: HyperLiquid did not answer` | The public API rate-limits bursts | Wait 10 seconds, run it again. Do not loop |
| `Too many sign-in attempts` | GDEX allows 10 sign-ins per 15 minutes | Wait 15 minutes. The harness normally reuses one saved session |
| A stop is refused as too close to liquidation | The stop is past 70% of the way to liquidation | Lower `--lev`, or a tighter stop |
| A limit entry is refused | A long limit must be below the price, a short limit above it | Change the price, or enter at market |
| `Playwright not found` | Chart images are optional and not installed | `npm run charts`, or use `--no-png` |
| Chromium fails to launch on Linux | Missing system libraries | `npx playwright install-deps chromium` |
| Deposit says the address needs more USDC | The deposit address must hold the amount plus 1% | Deposit a little less, or send more |
| I sent USDC but `check` shows $0 on Arbitrum | Wrong network or wrong token, or it has not confirmed yet | Look the deposit address up on [arbiscan.io](https://arbiscan.io). If the transfer is not there, it went to another network: ask the sender's support |
| Deposit sent, HyperLiquid still $0 | It takes about 10 minutes | Wait, run `check` again. Do not deposit twice |
| A money move answered with an error | It may still have gone through | Wait a few minutes, `node setup.js check`, compare balances, then decide |
| `npm install` warns about Node 22 | The SDK prefers Node 22 | It works on Node 20. Upgrade Node to silence it |
| Claude does not know the commands | The skill is not loaded | Start `claude` inside the repo folder, or run `node setup.js claude` |
| Leverage on the fill is not what I asked | The exchange refused the change (for example an open position at another setting) | `fire` warns when this happens. Size and stop prices are still right |
| The harness got signed out | You signed in to gdex.pro with the same wallet | Nothing. It signs back in on the next command |

## Getting help

Open an issue at <https://github.com/kingassune/degen-harness/issues> with the command you ran and its output.

**Never paste your wallet file, `.session.json`, or a private key into an issue or a chat.** Nobody needs them to help you. Your
public trading address is safe to share.
