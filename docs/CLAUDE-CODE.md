# Driving it with Claude Code

The harness ships a skill (`skills/degen/SKILL.md`) that teaches Claude which tool answers which request, how to state what a
trade will cost before placing it, and what never to do (print your key, remove a stop, touch positions it did not open).

## Two ways to load the skill

| | How | When |
|---|---|---|
| **A** | `cd degen-harness && claude` | Simplest. The repo carries the skill in `.claude/skills/`, so it loads whenever Claude starts in this folder. |
| **B** | `node setup.js claude` | Installs the skill to `~/.claude/skills/degen/` with this folder's path written in, so it works from any folder. Run it again after `git pull`. |

Check it loaded: type `/degen` in Claude Code, or just say "am I set up".

## What to say

**Looking**

| You say | What runs |
|---|---|
| "show me the action", "what's moving" | `sectors.js`, `scan.js`, `mom.js --hunt`, `pos.js` |
| "scope NVDA", "let me see the S&P" | `scope.js` and the three charts |
| "levels on silver", "where does my stop go" | `levels.js` |
| "3D on BTC" | `vol3d.js` and the image |
| "is ETH chop or trending" | `track.js` |
| "what's happening in semis" | `sectors.js --sector semis` |

**Trading**

| You say | What runs |
|---|---|
| "long BTC, stop 59,990, target 62,400, half leverage" | `plan`, a one-line statement of the cost, then `fire` |
| "short NVDA with a 20% stop and 60% target, max leverage, $50" | the same, in percent of margin |
| "limit long SOL at 142" | a resting entry |
| "stop to breakeven", "lock in 30%", "move my stop to 61,200" | `sl` |
| "extend the target to 150%", "take the target off" | `tp` |
| "close it", "flatten everything" | `flat` |
| "cancel that limit" | `cancel` |
| "watch it" | checks the position every two minutes and reports only what matters |

**Account**

| You say | What runs |
|---|---|
| "what am I up" | `pos.js` |
| "how am I doing this week" | `stats.js --days 7` |
| "am I set up", "where's my money" | `setup.js check` |
| "deposit 50", "take 50 out" | `setup.js deposit` / `withdraw` |

Before any order, Claude tells you: margin, leverage, dollars lost if the stop is hit and what share of the account that is, the
fee in dollars, and any warning from `plan`. If you did not give a size, that is 80% of the account. Say the size you want.

## Status line

Shows equity, open P&L and positions under the prompt. Add to `~/.claude/settings.json` (use the path `node setup.js claude` prints):

```json
{
  "statusLine": { "type": "command", "command": "node /path/to/degen-harness/statusline.js" }
}
```

## Fewer permission prompts

Claude Code asks before running a command. To let the read-only tools run without asking, add the rules `node setup.js claude`
prints to `"permissions": { "allow": [ ... ] }` in `~/.claude/settings.json`.

Leave `degen.js` and `setup.js` off that list unless you have decided you want orders and money moves to run without a prompt.
With the prompt on, you approve every live action yourself.

## Good habits

- Ask for `plan` in your own words ("what would that cost?") any time. It sends nothing.
- Claude cannot see the news unless you give it a way to search. The tools read price and volume only.
- If Claude says a command returned `ok: false`, read what it says is still live before doing anything else.
