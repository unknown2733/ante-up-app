# Finance market readiness handoff — 2026-10-16

Branch `work/finance-20261016`, baseline `471b69a`. No server write, transaction, push or deployment occurred.

## Result

- Added read-only `scripts/finance-market-preflight.mjs <market PDA>`. It verifies the Devnet genesis and finalized chain clock, reads the market, latest snapshot, finance accounts and actual SPL vault balance, then reports separate graduation, indexed trading and maturity blockers.
- Graduation checks the observed-source attestation, fresh matching snapshot, VALID/OPEN status, activity minimum/ratio, curve cap and reserve, actual assets against curve liabilities, five-market/50,000 tUSD support limits, exact target reserve + 500 tUSD buffer + 3,000 tUSD initial free capital, and the balance of an explicitly supplied administrator-owned tUSD support account. The support account is **not inferred** from the protocol treasury. Missing `ANTE_UP_FINANCE_SUPPORT_PAYMENT_ADDRESS` leaves `ACTUAL_SUPPORT_BALANCE_INSUFFICIENT`; this is intentional and fail closed.
- Indexed checks include maximum spot reserve, Pro reservation, other fixed/unpaid debt, 500 tUSD buffer, shares, anchor maximum, current NAV, data delay and the current Pro/LP phase. Historical weekly maturity uses the exact frozen candidate through T; current feed staleness is reported but never replaced with a current price. It also requires matching keeper scope, keys, attempts store and observed provenance.
- Keeper scope for a live Pro cycle is rechecked through `KitFinancialEpochChain.read`, which enumerates finalized positions and verifies the first opening time. The source attestation is an operator assertion tied to Devnet market/query hash; it is not independent evidence that X data are true. No action is unlocked automatically by this report.
- Three existing type annotations in `services/api/src/live-read.ts` were tightened without changing runtime behavior so the module type check passes.

## Read-only invocation for the integration owner

```sh
ANTE_UP_RPC_URL_FILE=/run/secrets/rpc.url \
ANTE_UP_FINANCE_SOURCE_ATTESTATION=/state/keeper/observed-source.json \
ANTE_UP_FINANCE_SUPPORT_PAYMENT_ADDRESS=<admin-owned tUSD token account> \
ANTE_UP_KEEPER_SCOPE=/state/keeper/scope.json \
ANTE_UP_KEEPER_JOURNAL=/state/financial-demo-20261013/settlements.json \
ANTE_UP_KEEPER_ATTEMPTS=/state/keeper/attempts.sqlite \
ANTE_UP_PUBLISHER_KEYPAIR_FILE=/run/secrets/publisher.json \
ANTE_UP_KEEPER_KEYPAIR_FILE=/run/secrets/keeper.json \
node scripts/finance-market-preflight.mjs <market PDA>
```

The attestation file contains `{"kind":"OBSERVED","cluster":"devnet","programId":"...","marketId":"...","queryHash":"64 lowercase hex","source":"X_COUNTS","synthetic":false}`; its content must be independently reconciled to collector and published observation records. The script only checks key/attempts file presence and does not open signer files or prove the attempts file is on a durable mounted volume. The operator must verify that mount, the publisher/keeper addresses, the candidate journal and adequate fee SOL before enabling the existing keeper service. The CLI exits 2 for blocked readiness and 1 for a read error. Its JSON contains no RPC URL or secret contents.

## Verification and current boundary

- `node --test services/keeper/test/*.test.ts`: **22 passed**. New cases cover exact graduation contribution and funding, stale/synthetic/mismatched observations, reserved liabilities and buffer, weekly candidate/keeper requirements, and historical maturity independent of a newer stale feed.
- `node --test services/api/test/keeper-*.test.ts services/api/test/financial-live.test.ts services/api/test/financial-indexed.test.ts`: **7 passed**.
- `npm --prefix services/api run check`, `node --check scripts/finance-market-preflight.mjs`, `git diff --check`: passed. Module lockfiles matched the existing local installation; ignored dependencies and generated chain dist were copied into this worktree only after `npm ci` failed in the restricted environment. No lockfile changed.
- A read-only request to the public API failed with `HttpRequestException` here. No server RPC file was available in this session, so the new finalized-account CLI has **not** been run against live Devnet. The 2026-10-16 project Working note says real `solana` is still CURVE with roughly 50.41 tUSD in its vault and the other two registered markets lack current data. Those are earlier observations, not new verification. Nothing here establishes that graduation, Pro/LP opening, a normal Monday maturity or continuous keeper operation is live-ready.

## Next bounded verification

1. On the server, identify one genuinely observed market and independently validate its source attestation, current X query and finalized snapshot. Run this preflight without signer loading or execution, preserve the JSON and current account slot.
2. Recheck the support payment token account and any existing obligations; do not fund or graduate until the on-chain curve cap, reserve, contribution and operator authorization are satisfied. Real `solana` may remain blocked until sufficient *actual* curve activity and capital exist. Do not refresh old synthetic finance QA as live observations.
3. After a real indexed market exists, re-run the report for spot/Pro/LP and verify quotes and actual reserve/NAV against the same finalized state. Build the exact current-cycle keeper scope and frozen historical settlement candidate before the Monday boundary. Use existing one-pass keeper preflight/execute recipe from `HANDOFF-keeper.md`; observe finalized acceptance, each position's fixed claim and full LP window. A local time-accelerated fixture is not a Devnet weekly-maturity result.
