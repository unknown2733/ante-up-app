# Financial runtime integration contract — revision 0.3

Implementation authorization: user requested proceeding with financial functionality while credentials/server setup proceeds, 2026-10-12. Domains/public deployment follow backend readiness and end-to-end checks. Product semantics remain MVP_SPEC and accepted sources. This is not an economic redesign or a deployment claim.

## Ownership and baseline

Baseline `3fcd6d2`; B owns programs/chain client, D API/indexer/keeper, F web, C settlement observation provenance. A owns contracts and integration. Use own clones and local commits; preserve the working free-record path. No deployment, paid providers, key extraction or remote push for this pass.

## Wire contract

`contracts/financial.ts` is the shared D/F DTO. Existing free endpoints/types remain compatible. All financial endpoints use existing Envelope and authenticated wallet session; no Pro/LP data enters public profile/leaderboard.

| Route | Request / result |
| --- | --- |
| GET /v1/financial/portfolio?wallet=... | authenticated FinancialPortfolio |
| GET /v1/financial/vaults/:marketId | public aggregate FinancialVault, no owner holdings |
| POST /v1/financial/quotes | FinancialIntent -> FinancialQuoteResult |
| POST /v1/financial/transactions/prepare | FinancialPrepareRequest -> FinancialPrepared |
| POST /v1/financial/operations/:requestId/submit | wallet + signature -> existing Operation |
| GET /v1/financial/operations/:requestId?wallet=... | authenticated existing Operation |

The faucet is a quoted financial action, requires wallet authentication and on-chain bounded mint/transfer. A default technical test allowance of 1000 tUSD per wallet per rolling 24 hours is configurable; this is a development limit, not a newly user-selected economic constant. No mainnet runtime accepted. SOL fees remain separate; no pretend SOL faucet balance.

Intent quantities: curve/spot=keyword atoms; depositLP=tUSD atoms; withdrawLP=share atoms; openPro=collateralAtoms+leverageBps+direction; closePro/claim=positionId/claimId. Faucet/register have null marketId before market creation; registration uses keyword+aliases. All integer amounts are canonical decimal strings, six decimal atoms. Reject inappropriate/missing fields, zero amounts and unsafe timestamps.

For a new Pro position, derive its numeric on-chain ID from the first eight bytes of SHA-256(`ante-up-pro-position-v1:${requestId}`), interpreted as unsigned little-endian u64. Bind the position PDA to that ID, market and wallet in both API and browser verification. Existing `positionId` and `claimId` fields in close/claim intents are base58 account addresses, not numeric IDs.

Quote UUID and immutable intent are stored with 30-second expiry; prepare uses the stored quote, not caller-supplied money fields. Bind network/program/wallet/market, state/config/snapshot versions, max payment/min receipt, maturity and max payout. A quote never reserves liquidity. Chain rechecks all applicable conditions. F verifies the exact instruction/accounts/data before signing. Instruction validation must account for legitimate associated token account creation without permitting arbitrary transfers.

Curve quotes have `snapshot:null` and generated curve instructions use `expectedSequence=0` as a sentinel. Curve execution checks configuration, financial state, deadline and slippage, but not external observation readiness or sequence. Graduation and indexed actions retain their observation binding. This preserves parallel curve trading and data preparation without adding a new economic rule.

Operation reconciliation verifies the exact prepared message and wallet signature. Timeout/lost response is UNKNOWN, not failure or permission to resend. Persist quote, operation and prepared bytes before send, and expose manual recovery. Missing actual adapter -> notExecutable. Injected tests must be labelled; a fixture must not appear to move assets.

## Asset and accounting invariants

Standard SPL tUSD and keyword mint, six decimals. Keyword fixed supply 2000, curve cap 1000, same mint at graduation; revoke further keyword mint authority. Only tUSD faucet mint authority is retained by the program. Use separate controlled token accounts and checked CPI constraints; actual account balances back reservations. Direct token donations must not fabricate sales or erase liabilities. Token burning/transfers must not silently reduce outstanding spot obligations.

Curve pricing and fees follow reference.mjs: q is net sold, gross is the integral difference; buy ceil/sell floor; 10bps fee with protocol floor20%, market remainder. Registration10 tUSD. Market fees cannot be withdrawn before graduation. Graduation is atomic and once-only, supported5-market budget max50000, market contribution max10000, actual funding required, B500, targetF3000. Require current ready/OPEN activity, 0<rG<5 and q1000. Anchor/Pmax fixed forever at graduation. Raw ratio changes do not re-anchor weekly.

Vault A includes real receipts; reserves Rs=ceil(Q*Pmax), Rp=sum(max payouts), H=unearned refundable fees+protocol fees+unpaid claims. Never double count collateral or move unpaid claims into free capital. F=A-Rs-Rp-H-B. New trades and withdrawals require post-F>=0. Reserved exits/claims do not depend on spare F. Current price zero is possible; Pro entry price zero is not. Positions retain max reserve even when current payout is zero.

Pro collateral C, notional=floor(C*L), L1..5. Payout and maximum via reference.mjs, no netting long/short. Store each position's rates/maturity/reservation; freeze payout/refund once at close/settlement, pay once. Trade fee10bps at entry only; time capital2bps/day and protection5bps/day prepaid to original maturity and refund unearned. Whole closure only; no automatic rollover.

NAV only with no unresolved/open Pro and current valid price: E=A-Q*P-D. D includes fixed unpaid obligations. Maximum spot reserve and buffer are NOT also NAV liabilities. Locked initial shares=initial E. External shares floor(d*S/E), redemption floor(s*E/S), no zero-share deposit, initial shares cannot redeem. Pari passu loss allocation. All LP execution requires windows and post-reserve solvency.

Weekly maturity Monday00:00UTC; open cutoff30min. Settlement input fixes activities through T, accepted by T+900, with first-complete-recovery and original outage+24h exception rules. No late keeper substitution of current price for maturity price. Every position uses common immutable input. LP window opens after every amount is fixed (not every claim paid) and current NAV valid; 900 continuous seconds, reset after outage. Initial LP900secs; empty cycles per accepted graduation source.

Settlement `epoch` means the finalized finance market's `current_cycle`, not a calendar-week number. The candidate journal, keeper attempt, on-chain settlement and positions must bind the same cycle. Emergency settlement can finish a cycle early; reopening before the same weekly maturity creates a new cycle and cannot reuse the prior candidate. `epochStartedAt` is the first position opening of that cycle. LP continuity must detect expired prior data even when a newly received snapshot is itself fresh.

## Evidence gates

Mandatory verification covers CPI/token owner/mint constraints, unauthorized withdrawals/mints, quote mutations/staleness, simultaneous capacity, repeated settlement/claim, initial share lock, complete cycle, zero/low/outage state, fee refunds, and conservation through alternating long/short entry/exit. Host Rust tests and transaction serialization do not substitute for compiled SBF execution.

Remaining provider/environment gates must stay explicit. If compiled execution cannot run locally, leave its tests skipped with a reason and document exact run instructions. Do not call an unexecuted Devnet flow complete.
