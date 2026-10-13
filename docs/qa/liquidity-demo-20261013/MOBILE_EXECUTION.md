# Seeker liquidity and Pro verification — 2026-10-13

Environment: Solana Devnet; explicitly synthetic `Liquidity market`, ApyEauP8KhFLxo6v1BTkJSiJogN9dKXueM715GBdyZDP. User approved on Seed Vault; root alone operated device. Financial agent only read results/simulated after activation and graduation.

## Confirmed actions

- Graduation: `4JA6FVNjUp9vNSwbc7DxT5xKqdHdPkJJPeeH5LZ3akU5kFEQf93U7cbEQa99iZnQ1UtKmHkQPGDRKtY8naAYqa3f`, FINALIZED. Initial LP window ended 01:07:12 UTC. Assets8300, NAV7100, initial free3000 tUSD.
- LP deposit10tUSD: request618f005e-bc29-4f75-a58f-ad83df131b08, signature `3BjzmBmhxFQMzhukBCDLc3qnWB7fMjvDatJcKwxGczzqkfovtqpoVG93Ve3hKjro1rzVqaCfSSEyfeXaq5Dpky9t`, FINALIZED01:03:43 UTC. Wallet989.997998tUSD, shares10.
- LP withdrawal10shares: request034ec4a5-6378-4426-a49a-ba569529642b, signature `4PpFmpJXBA4L4MrUNMAPM5Ut8HdmGEN25k7ci4uthzw8S9exvTN1b4bNCg8hntBjNG4GQx9T6QnXX6Z6Gggq7Gs6`, FINALIZED. Holding shares0; totalShares=lockedShares7100.
- Spot buy1token: request31e8e3fd-7dd2-432d-b407-13f937f31cb0, signature `5FLrQMTu19WfGtMdL9DWM93FhF6MYD5FXmcM4hedBjfgW8bBKLm455Rcvfds7d3nU3ZwXmm7chqpzHBYSVnEDCPu`, FINALIZED. Wallet998.796798tUSD, token1.
- Spot sell1token: request819b21b8-058c-4964-b708-475672c81e8e, signature `31V3TQz1RDW1tMYu4jnpEqrWziZovoU3hzkusDLWR6DkQaYRA2x2uzyPkcizgyDucB7E2ty2FnprtqMQmHKqGv9n`, FINALIZED. Wallet999.995598tUSD, token0 (root UI + later chain outsideQ1000).
- Pro long10tUSD/5x: request86c277c3-33ae-4ef3-8f1c-a4ac896089d9, signature `48JVeEiP6E2o6rrHAxFd3MxqeJ3ptW9Z6iodPjsxBvCC7JeuQuuFGeQkXmVcKHiPP1uZzxQhgWWtFAXL82zx2yYe`, FINALIZED. PositionBpRPnZuXg93PLcTsy6ebzhebKszv6REJDbU7ik4RcxCe OPEN, price1.2, notional50, maximumPayout/proReserve160, prepaid/otherReserve0.327221tUSD. Wallet989.618377tUSD.

## Finite service controls

- Existing free admission window closed FINALIZED01:08:55.942 UTC, signature `5X5czQXsioP8mpJhn8abWWXzNYtzdwtx2voaqabi1QxBErgUuNa686uKeZkNs9GoBrD96PC4CdtY4ampPrqR7WUe`. Container exited0 at01:08:57.778. Readback open=false/outstanding4/recent24h6.
- New synthetic feed `ante-up-liquidity-feed-20261013` began00:52:34.656 UTC, maximum15 passes separated240s, restart=no. Approximate end01:49 UTC; actual completion still requires later readback. No new real X query or public collection entry.

## Pro close defect / evidence boundary

Request6d25f8f4-0a96-4558-b76a-81f653aacff8 had quote01:13:54 UTC, expires01:14:24 UTC, minimum receipt10.327179tUSD. User reported wallet instruction error. Server UNKNOWN/nullsignature; no close transaction in wallet history. Original wallet simulation logs were unavailable, so the exact original failure remains unproven.

At01:17 UTC, replaying old unsigned transaction with replaced blockhash returned QuoteExpired6009. This is a later-simulation result, not evidence of the original cause.

Controlled current-state simulation refreshed deadline/sequence/config/state only and preserved original minimum receipt10327179atoms: Slippage6010 at finance.rs875. Same current parameters with minReceipt10000000atoms succeeded. Neither simulation signed or broadcast. Position remainedOPEN, claim absent, reservations unchanged.

Root cause in code: API close minimum included quotedAt refund, while on-chain close deducts elapsed fees through execution time. Thus normal wallet approval latency can reduce actual refund below minimum despite unchanged price.

Fix9a7d525 calculates minimum receipt at quote deadline (bounded to maturity-1), keeping exact state/sequence/config guards. Actual claim still records execution-time refund. Regression covers both directions over every second of the quote window and maturity boundary; API typecheck passes. Live patched close/claim/short verification remains pending at this document revision.

At 01:22 UTC the API-only image `ante-up:pro-close-d58ea54` was deployed and reported healthy. The same Linux image passed the indexed financial regression and API typecheck with a writable test-only `/work` mount. Public source commit is `c27daea`; web remains `20780b3`. The first patched request `570c8c15-4493-4832-804e-7a22a3f0598d` included the corrected minimum10.326809tUSD, but its 01:23:35 UTC deadline elapsed while the native wallet still awaited approval. No close signature or claim was found; this is not a successful patched execution. The user requested another attempt after that request was reconciled.

An earlier spotSell review returned generic FINANCIAL_CHAIN_STATE_NOT_READY; no branch-specific evidence was persisted. Subsequent direct production reader quote succeeded with matching chain/view sequence/hash and token1, then user sell finalized. A transient snapshot race is possible but not proven.

### 10:40 KST Pro long close confirmed

The coordinator confirmed the real Seeker long close FINALIZED: request `4a75b231-2946-47df-a08d-03b3c905c12d`, signature `44vdwm48Wa833XtatiHAWJ8KvxgHiviVJabpgZaDKSYYwhW7iUbMThFTJEUxwyjFycckYU1PQ19CUDCRjfY3wudW`. Position `BpRPnZuXg93PLcTsy6ebzhebKszv6REJDbU7ik4RcxCe` became SETTLED. Claim `BJmxZLkNEJTKKsVym5X3qXQirkgDyiwwLzTMJ6Eb8kR1` was UNPAID for 10 tUSD payout + 0.326152 tUSD refund = **10.326152 tUSD**. The signed minimum was 10.326145 tUSD; actual settlement exceeded it, confirming the refund/deadline fix in a real transaction.

Pro reservations fell to zero and other reservations became 10.326152 tUSD for the unpaid claim. Wallet balance remained 989.618377 tUSD: closing created the claim, not a completed payout. At the subsequent 01:41:59 UTC claim-approval step, the user's signature was pending. Claim payment, short-side coverage and remaining maturity checks are not marked complete. Earlier failure/pending entries above remain historical checkpoints.
## Final Seeker QA readback — 01:49:53 UTC / 10:49:53 KST

The coordinator observed native wallet success for the completed Seeker chip, curve, spot, LP and Pro long/short open→close→claim flows. The final financial readback establishes the following additional completions:

| Action | Request | Finalized signature / result |
| --- | --- | --- |
| Long claim | `ae34d59c-3c7a-4a53-86d4-c7ffd85881da` | `5i7GF8BsoRAbMFprQLMwqdH6zYeRLB76efavY91HMq2pdKvAvujaHL9DxM4Zq3oiRQ5gJbL3CXd296Zj2gxrMsEz`; paid 10.326152 tUSD, wallet 999.944529 tUSD before the short flow |
| Short close | `a20cfb2d-717b-4c59-82e6-8be447699766` | `5G4uy3DM1RFGM11QAzgNXKzwvy8AcbCd5DebPSSs9JLN2RtuxdQKxY8a9LKH5f9V9smdXTVE3Qaf4x6zcPzd1ZCm`; FINALIZED |
| Short claim | `73dce29b-af52-4173-b8c7-e960ee521709` | `ipPZyH9FqkZY95Z7Qb6iQ4qyAWULb65DWYz4cv4cymPnB7p9Jf4tXSj8NWochNQaFi3qnH73j9wkf5iZdpfCi4W`; FINALIZED |

Short claim `H5BUJJVzeGmGuUJZoGoiATrNmGdXxb7bdakFTQpFRVLJ` is PAID: 10 tUSD payout + 0.207451 tUSD refund = **10.207451 tUSD**. Both long and short positions are SETTLED and their claims paid. Final test-wallet balance is **999.894497 tUSD**, with zero LP shares and zero market tokens. Pro reserve and other reserve are both zero. Vault assets are **8300.083021 tUSD**, NAV **7100.083021 tUSD**, and free capital **3000.083021 tUSD**. `outsideQ = 1000` refers to the initial QA holdings elsewhere, not residual holdings in this tester's wallet.

This closes the previously pending device close/claim paths; earlier pending and failure paragraphs preserve their observation-time history. It does not establish normal weekly maturity execution, stress safety, mainnet readiness, or completed demo recording. **Normal weekly maturity and recording remain untested/unfinished.** New-chip admission and the initial LP window are closed.

Bounded feed final readback: ApyEau has one graduation observation plus 15 refreshes (16 total), last observed at **01:49:55 UTC**. The feed container exited **0 at 01:49:59.400 UTC**, with no writer lock remaining. No restart or extension was performed. The Free gate and both synthetic feeds have finished; the actual X collector is unchanged.

Deployment remains public source `206d58d` / tested integration `78a1d10`, image `ante-up:capture-quote-78a1d10`. This closeout updates documentation only and adds no deployment, transaction or device action.
Fee reconciliation for this constant-price test: 999.997998 → 999.894497 tUSD, a net cost of **0.103501 tUSD** = spot 0.0024 + long 0.051069 + short 0.050032. Vault gain was 0.083021 tUSD and protocol income 0.02048 tUSD. The synthetic price stayed at **1.2**; these executions validate flow, costs, refunds and reserve release, not gains/losses under a changing market price. A separate post-payment empty-claim UI message correction is in progress and is not part of the recorded deployed release.
## Final empty-state UI release and Seeker record check

Integration `b478b85` clarifies empty claim/close controls in `Financial.tsx`; financial guards and payment rules are unchanged. The web-only image is `ante-up:final-empty-ui-20261013`, SHA-256 `c20c87b9edb6c778e92ea13417692a7708bede2ad062f08d770db764f7a07086`. Live/image JS `index-CBla-MRm.js` matches SHA-256 `cec1f2af06d3abe2d9515bf2b547f6c1513bfb09d128740d7ba05ad15938fcd6`; CSS remains `index-Dly_HIQq.css`. API remains `ante-up:capture-quote-78a1d10`, and `/api/v1/markets` returned 200. Linux build, API typecheck and 14 financial UI tests passed.

Root also verified the actual Seeker EfCp record page: solana, **−0.01%**, placement **00:37 UTC**, return **00:43 UTC**, **Proof pending**, and Verify record. This adds a physical-device display check to the earlier isolated-browser capture. It adds no wallet transaction or proof issuance; normal weekly maturity remains unverified.

For completeness, the successful SHORT open preceding the close/claim above was request `e303b48b-42d4-41ef-b41b-ea07373aaa9f`, signature `5rg4TSa5EFd62Xt2wANceXXmD6Cvh4EDxCb9sUtmMicDxmSyj5ShQZoCyhahZYUfWaTUtKo1sF7KhfJVVnexK1VJ`, position `CgSs5WcQ2CWgAoCRBwwz3KjRHN5BDTT5BZEjZEGiTa9V`: collateral 10 tUSD, notional 50 tUSD, 5× leverage, entry price 1.2, maximum payout 60 tUSD, prepaid cost 0.207483 tUSD. This is the already-completed short flow, not an additional position.