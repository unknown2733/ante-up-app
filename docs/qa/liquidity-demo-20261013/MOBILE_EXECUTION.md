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
