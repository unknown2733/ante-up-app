# Live Devnet validation — 2026-10-12

## Scope

Actual X Counts, Helius Devnet, deployed Anchor program, generated SDK, production web controllers, a real loopback HTTP API, real Ed25519 wallet signatures, finalized receipts and SQLite projections. Wallets were generated and kept on the deployment-host for this test. This does **not** establish Phantom/Seeker browser interaction, mobile UI rendering, public HTTPS deployment, Arweave inclusion or SAS issuance.

Program: `FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr` (existing verified SBF; no program redeployment in this pass).
Market: `7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT`.
Keyword mint: `CEdCDfehgtghUwsVfmn5BSqXs6fNcfzrNUp3uZEECq4v`.
Query: `("solana") lang:en -is:retweet` (query version 1).
Query SHA-256: `e90d17a9452f18411f83cec70f7c32e3414770b8aca80ab1b0572ae311aa9c9d`.

Only this one keyword was queried. No other keyword collection was enabled. Original responses, replay inputs, publication jobs, private test signer material and SQLite state remain in `/srv/example-app/builds/runtime-state/live-smoke`. Private signer files must not be copied into Git or the vault. The public report contains addresses and signatures only.

## Verified financial path

Web/API test wallet: `CjyUYdPpyuivcmqe7VGU7xeWMZRJnqJioR1Kzf4emoym`.

| Action | Finalized signature |
|---|---|
| App faucet: 1,000 tUSD, including ATA creation | `3vS8sJDZr8YNKHWqzZkGtE1CWTNg1kKoBYHrgcrLCuqEugJSUvVuhuRPw22YDdHfXPxbsa1MuztKbUaCxBkYQovn` |
| Curve buy: 10 keyword tokens | `2Wi9qjRHvvqy3PdYWRMcECCMa5t2JC9cTgBkTCHsykvZ14TQQVdBcs4QsT1YGEAnH43NBupXoZkGDwfqwKFBAp1Z` |
| Curve sell: all 10 tokens | `k52DwhVC2Jd16Gm7McfroFAXxtSCmW8adJiWkDBpKBBMivbEoRjgFrf9kpKA2HSvDx3K6xBabtLeJjo47cgEGRi` |

Round trip: buy gross 10.01 tUSD plus 0.01001 fee; sell gross 10.01 minus 0.01001 fee. Final wallet balance **999.979980 tUSD**, keyword balance zero, no Pro position or LP shares. Authentication used an actual challenge signature. Financial transaction verification used the production web verifier and finalized RPC accounts. No fixture balances/receipts were injected.

A separate SDK test wallet `EygraQQEAQZUgvHUX9rLkPJtDYq3nowL7RVaLgoJFjdX` also claimed the faucet, paid the 10 tUSD market registration fee, and completed the same curve round trip. Those are separate test transactions, not additional outcomes from the app wallet. Both were funded with Devnet SOL for fees/rent. No mainnet assets were used.

## Data and free records

Initial archive returned **40,320 minute buckets / 28 days** in one actual Counts response. The response was content-hashed and replayed with the accepted three-day EWMA and seven-day comparison. Publication sequence 1 was finalized and independently resolved through its account and indexer. A bounded follow worker then fetched current observations at five-minute spacing.

A first SDK free record entered while its data was stale and was retained: it closed as **N/A**, not an invented return. Its address is `7hz4GJhPVFqv38NWN7yhiz2afKCBiJ1D1xuJy4bjyp7g`; closing signature `4ncy9FfGxNCaEnwQsxAEGybzWUpBaNHfXRD2R6Rq9MgTnMBhQAZcNPs7TQ5baFTMYKfv53e7QnLuXcY6sSJj6ABx`.

The app free entry was finalized with signature `5zE4TRM25ctLBuHLxw2PG9qVwaG2muvB8aTbp1b675qVr1vpZxgWBc2ebhSiJTn5aoHing64M3CA2rjoZg2ULga8`. After the next real observation, the app closed record `CjbpsPJJyqKBxoAmUcMTet5HNXz6hQxeeHquAN4afJTN` with signature `tM2PazMP5qjkvx1Wek9ZJPNLJgmADoJ19zHjj8MWm6pdG9SQupLuPwzvkQ55j7s6bxXg5eNwxELMu1aoQtaFp3Y`. The finalized projection is **CLOSED_RESULT**, entry sequence **3**, exit sequence **4**, return **+0.02515197%** over 264 seconds. The result is an exact on-chain rational; the percentage is rounded for display. `proofId` remains null.

## Fixes found with live execution

1. Publisher runtime passed a signer object where the transaction builder requires its address. Corrected the example and CLI fallback.
2. A late worker fetched only five old minutes every five minutes, preserving its backlog. It now requests all missed completed buckets within the recent horizon. The ingest validator accepts the same bounded range, preserves missing-vs-zero semantics, and still counts the batch as only one recovery observation. During verification the range-validator mismatch safely produced an OUTAGE; this was an internal validation error, not evidence that X returned bad data. Original raw evidence and the outage snapshot remain in the journal.
3. Free transaction preparation compared a newly generated expiry against the earlier request-start time. Real RPC latency therefore caused false rejection. Validation now uses the completion time, with an additional expiry check before returning. A deterministic latency regression reproduced the failure before the fix and passed afterward.

The standalone SDK harness also initially used a 60-second deadline and a data sequence for a curve quote; both were correctly rejected by the program before broadcast. The corrected harness uses the permitted deadline and sequence zero. The production financial API already used those correct rules.

## Operational boundary

The collector entry point is `scripts/collect-devnet.mjs`. It verifies Devnet genesis, the registered PDA/query and publisher authority, reads secrets from server files, enforces persisted budgets and retry spacing, and reconciles real finalized projections. Free admission is opened only for bounded test entries, then closed. Proofs remain pending until the separate Arweave/SAS path is configured and completed.

The market remains in CURVE phase. No graduation, indexed paid trading, Pro or external LP flow was exercised live in this pass. Their earlier Linux tests remain separate evidence. The live API ran on loopback for this validation, not on the public domain. Process supervision, backups and phone/browser-wallet checks remain deployment work.


## Final execution state

Four real X HTTP requests were made (one archive, three recent calls including the failed-validator attempt). Local cost reservation is **$0.04** at the configured $0.01/request estimate; this is not a confirmed X invoice. Recovery was observed as BLOCKED → RECOVERING(1) → OPEN(2) across real five-minute polls. All four snapshot publications reached finalized state and resolved through the indexer. The last valid publication is sequence 4, signature `aMfMZK7KcpgJuwkaZrQXyb3p4abXKmb2CgUowCqZfL7QL4cUpiheuJUcugShpubeQtstr8KCyJRGu7PLb1hdVkz`.

The bounded verification collector was explicitly stopped after sequence 4, before another paid call. The temporary API processes exited after each test. Public free admission is closed; both free records are closed and awaiting evidence/SAS work. Source data will become stale until a supervised collector is started. Test-wallet tUSD is faucet-issued; the harness separately supplied Devnet SOL for account rent and transaction fees. Public visitors still need a SOL funding/sponsorship experience verified before launch.

## Verification gates

- Linux module/integration suite: **163 passed, 0 failed, 0 skipped**, including both compiled LiteSVM tests.
- Linux web suite: **22 passed, 0 failed, 0 skipped**; chain/API/indexer/web type checks and production build passed.
- The two later core-initialization tests were copied to the server and run separately: **2 passed**. Total Linux coverage executed here: **187 passing tests**.
- The Windows aggregate before the API-latency fix passed 184 tests with two native skips. A subsequent aggregate exposed an intermittent existing bootstrap-journal write test failure; the isolated six-test bootstrap suite passed. Linux then passed that test within the complete suite. No unverified claim of a clean final Windows aggregate is made.
- Independent finalized readback after all flows confirmed admission closed, Faucet issuance 2,000 tUSD total across the two test wallets, curve sold zero, no open Pro, and the app record's entry/exit both usable. Two evidence/SAS obligations remain outstanding.

Public transaction/result evidence: live-devnet-2026-10-12.json (private deployment evidence). Original query raw blobs and complete replay journals remain on the deployment-host.
