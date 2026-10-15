# Wallet and faucet

## Connect on Devnet

Use a compatible Solana wallet and check that its network matches the market's Devnet cluster. The app cannot silently switch your wallet or network. A mismatch with the API or market makes signing unavailable. Reading Docs and Explore needs no wallet.

## Two test assets

**Devnet SOL** pays Solana transaction fees. The app's [Faucet](/faucet) checks the connected wallet's SOL balance and, when the operator has enabled a capped funder, can send a small test SOL grant. Otherwise use the linked official Devnet faucet. **tUSD** is Ante Up's test payment token for financial flows. The same page requests tUSD when the route and configured supply permit it. Receiving tUSD does not supply SOL for fees.

The tUSD amount, cooldown, total issuance cap, and availability are configured on-chain. Read the current quote and wallet request; do not rely on a guide for a fixed amount. Reconnecting cannot bypass a cap.

SOL grants have separate server limits and a dedicated test wallet. A pending grant keeps its request ID across a page reload; check its status before trying again. A submitted transfer is complete only after finalization.

## Signing and recovery

Inspect every wallet prompt. Explicit rejection leaves that attempt unsigned. A timeout or network interruption can leave the outcome unknown, so check [Activity](/me) and operation status before trying again. A wallet popup closing is not chain finality.

Wallet sessions are scoped to the connected wallet and cluster. Changing either clears the session. Never enter a seed phrase or private key into Ante Up or a support message.

## Read next

- [Chips](/docs/chips)
- [Markets and trading](/docs/markets-trading)
