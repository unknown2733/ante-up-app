# Devnet deployment record — 2026-10-12

## Verified source and binary

- Program: `FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr`.
- SBF source commit: `4b658eb` (actual identity applied, generated clients updated).
- Source archive SHA-256: `7e7faf76e6f6c96dd816c889487456dc1847825990b1f9c6db6f80bde8ad6f16`.
- Linux build directory: `/srv/example-app/builds/4b658eb`.
- SBF size: 693,080 bytes; SHA-256 `4afa5e5bc88de21954c7b02be6e2cc6b7a34fa86b33cfcb3af588adca7ec5419`.
- Linux `anchor build` succeeded. Compiled IDL equals the committed IDL structurally.
- Linux LiteSVM/client tests: **16 passed, 0 failed, 0 skipped**, including the financial SPL cycle and free flow.
- Local aggregate after identity change: **181 passed, 0 failed, 2 native skips**, TypeScript and Vite passed. New initialization safety tests: **2 passed**.
- Core initialization CLI added in `080d3b1`, full RPC-confirmed genesis correction in `c589193`; these do not alter the SBF source.

## Role mapping and prepared accounts

| Role | Public address |
|---|---|
| Deployer / initial protocol admin / treasury owner | `5Fm81PP7TXvyNJHoB4DrwWETYdfqKtc45s6WRK8qdx5e` |
| Publisher | `8qfbLii5YBfJiHoLGBNozyJnLFA4knBymTCtK9pP4mHH` |
| Proof authority | `9WYPtXD1C4CJmsRcN6LaG5frQdvhKpyQuL4RxiZcSRdu` |
| Prepared tUSD mint | `71sfbfYrJ9E417R57Ra2d5z1gp8xCbXJbgGTpT8bgLHe` |
| Deployment buffer | `CGqLoB4j1ULVQH9zqEAJdPDDYbSLMtshfTYjBijN54o9` |

Keys remain under `/srv/example-app/secrets`; no private bytes were copied into the repo or chat. `devnet-tusd-mint.json` and `devnet-buffer.json` were created on the server for this deployment and should be included in the user's private key backup procedure.

Core initialization preserves the default closed free-record admission gate until collection/storage budgets are configured. Financial bootstrap uses the existing 50,000 tUSD support capital, development faucet default of 1,000 tUSD per wallet per 24 hours, and an explicit deployment ceiling of 100,000 tUSD total faucet issuance. This ceiling is an operator test setting, not a new accepted economic policy. All amounts are test tokens.

`scripts/initialize-core.mjs` checks the actual Devnet genesis, deployed program and configured authority addresses. It journals a signature before sending and never automatically resends an uncertain initialization. `scripts/bootstrap-finance.mjs` continues mint creation, treasury ATA, support minting, mint-authority transfer and finance initialization from its durable journal.

## Current execution state

**Devnet deployment and core/finance initialization are complete and independently read back at finalized commitment.** The user topped up the deployer to 4.82499 SOL. Public RPC returned HTTP429 after buffer allocation; that process was interrupted without closing the buffer. The user stored the Helius Devnet endpoint in `/srv/example-app/secrets/devnet-rpc.url`; the endpoint was consumed only on the server and never printed. Deployment resumed with the same buffer and verified genesis.

- Deployment signature: `YRNZVar6UPFyz8a11aj75DzFMo4vNDiv8gwqaUNvVD9yPTXQe4q6JK5FSUXPQtngxjQMMrBBuhQ7Q44VsjETCkZ`.
- Finalized deployment slot: **510232317**.
- Program-data address: `BxAL3sPeJKutx6vw8ASEHHzor7UVReeHb8eocs6VHW5T`.
- Upgrade authority remains the deployer. Owner is the upgradeable BPF loader.
- Dumped on-chain program is **byte-for-byte identical** to the Linux-verified 693,080-byte binary above.
- Core initialization signature: `3gU9GRonbhnXq9CGWDyN4HWDTWsJqqm15bk6fyPFCHXCzJQ1M1akx6J33mPxFfB3TE9cUWxdjgdGVkWcZcZerV2b`.

| Finalized account or setting | Verified value |
|---|---|
| Core config | `2csQh3kxzfPqWjFDBzPY4X9SY1tsrjPsHPFfzpiQbEit` |
| Admission | `2MnN6woP2JiBJnPvhKsRWuA7Bc2VSUSx6GNjDwGS9r5R` — closed |
| Finance config / tUSD mint authority | `5qDzvmz7Z9YyBm7mT6ZoHNcpzoAmvLeGLbf6mGamshar` |
| Treasury ATA | `EqUPGzgFeMnw6JG3bLnaz8UPZbKQKppXjC1mQJK8gfHU` |
| tUSD supply / treasury balance | 50,000 / 50,000 tUSD, six decimals |
| Freeze authority | None |
| Faucet | 1,000 tUSD per wallet / 86,400 seconds |
| Faucet global ceiling / issued so far | 100,000 / 0 tUSD |

`scripts/verify-devnet-initialization.mjs` verified finalized account owners/PDAs, consistent administration, mint authority, treasury ownership, initial supply and closed admission. Runtime evidence is retained under `/srv/example-app/builds/runtime-state` and locally in ignored `.runtime/` public-result files. The mint and financial config were created successfully through all five bootstrap stages; journal state is complete.

**Remaining scope:** actual product keyword registration/collection/publication, wallet end-to-end transactions, Arweave/SAS configuration and issuance, backend process supervision, mobile signing and public domain/HTTPS. The protocol is deployed; the public application is not yet live. No paid X or permanent storage operation was performed in this deployment pass.

### Subsequent live application validation

Actual X collection/publication and Devnet wallet Faucet/curve/free-chip flows have now been verified. See [LIVE_DEVNET_VALIDATION.md](LIVE_DEVNET_VALIDATION.md). The supply/faucet values in the initialization table above are the historical initialization snapshot, not current balances. This later pass issued 2,000 tUSD to two test wallets. No program redeployment was needed.
