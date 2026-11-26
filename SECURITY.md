# Security

## Reporting a problem

Please do not open a public issue for a security problem. Use GitHub's private reporting on this repository
(**Security → Report a vulnerability**). Include what you found and how to reproduce it.

## How your key and money are handled

- `node setup.js` creates a wallet on your machine and writes it to `~/.degen/wallet.json` with mode 600. The file is outside the
  repository and is never printed by any tool.
- That key signs you in to GDEX. GDEX runs a managed trading wallet for you (your "trading address" / "deposit address") and
  places orders on HyperLiquid from it. Money in that wallet is in GDEX's custody, the same as trading on gdex.pro.
- `.session.json` holds the current sign-in (mode 600, git-ignored). It expires within 8 hours.
- The read-only tools use no key. They call HyperLiquid's public API with your public address, and the Arbitrum public RPC for
  the deposit-address balance.
- The harness sends your key nowhere. Signing happens locally through the `@gemachdao/gdex-skill` SDK and `ethers`.

## What you should do

- Back up `~/.degen/wallet.json` somewhere encrypted. There is no recovery if it is lost.
- Never share it, commit it, or paste it into a chat, including with an AI assistant.
- Keep only trading money in the account.
- If you let Claude Code run `degen.js` or `setup.js` without a permission prompt, it can place orders and move money without
  asking. Leave the prompt on unless you have decided otherwise.
- Anyone who can read your user account's files can read the key. Do not install this on a shared machine.
