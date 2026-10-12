# Demo execution readiness — 2026-10-13

## Completed now

- Actual Free gate: operator paused, outstanding 3/200, recent24h 5/100 at the read. Prior closure was the end of a bounded Android QA window, not a recorded incident. API now distinguishes ENTRY_PAUSED from LIMIT_REACHED and data readiness. Exit is unaffected.
- New **synthetic** Devnet financial demo market prepared with 9 finalized transactions; public signatures are in prepare-journal.json. No X query, no observation, no graduation, no LP clock and no public collector entry were created.
- Market `CFAAiVZD1PGcRrPEikjAZjtmnc2tNnp1g7Jk5RdpK2SG`, seed `4e3fe98cbf16ed91971da66fbb56c53b761b78c60dd18c4573c844414dae1792`.
- Curve sold 1,000 tokens; reserve 1,100 tUSD; market fees 0.881920 tUSD. QA wallet `4jKJoaVxSBeeaG9pio75NDyF7rveBe4qt7kuU5RDpRix` owns these tokens and 388.897600 tUSD. It received 0.06 Devnet SOL, 1,000 faucet tUSD and 500 treasury tUSD. No support contribution yet.
- Real `solana` market remains CURVE for the human curve-buy/sell flow. Do not graduate it merely to unlock demo Pro.

## Prepared server files / release prerequisites

- State: `/srv/ante-up/builds/service-state/financial-demo-20261013`.
- Staged registry: `markets.staged.json` in that directory; backup `markets.before-demo.json`. Active `/srv/ante-up/builds/service-state/markets.json` was not changed. Merge latest active entries before activation, rather than overwrite concurrent additions.
- Staged registry preserves the real solana entry and adds keyword `Synthetic finance demo`, `dataProvenance: SYNTHETIC_QA`. New API exposes explicit synthetic labels and disables its Free entry API; this is not an on-chain restriction on direct custom transactions.
- Empty `candidates.json` exists there. Append `/state/financial-demo-20261013/candidates.json` to indexer's ANTE_UP_EXTRA_CANDIDATES_PATHS, preserving `/state/financial-qa-20261013/candidates.json`. Restart indexer with the verified image before publication.
- API + price-history use `/state/markets.json`. Deploy provenance-capable API and web before registry activation. Collector keyword configuration stays unchanged.
- All keys remain server files mounted read-only. No private wallet file belongs in a report, checkout or image.

## Execution order when UI and tester are ready

Use the verified new image, from the release root on the home server:

```sh
export ANTE_UP_IMAGE=ante-up:VERIFIED_RELEASE
sh deploy/run-financial-demo.sh status
# Only after root confirms candidate-path import is active:
export ANTE_UP_QA_CANDIDATE_IMPORT_READY=yes
sh deploy/run-financial-demo.sh graduate-demo
sh deploy/run-financial-demo.sh feed
```

`graduate-demo` publishes a canonical explicitly synthetic observation, graduates with **at most 7,200 tUSD** treasury support, and stops immediately. It does not consume the human's LP window by making test trades. Initial LP window lasts 900 chain seconds; use it for LP deposit/withdraw, then Pro opens. Spot can execute in the initial window subject to reservations. No global caps are raised. Preflight retains at least 0.2 admin SOL; total new-market budget is 0.1 SOL, 7,200 support + 500 wallet top-up. The original supported-market/global treasury constraints remain enforced by the program.

The feed has a hard 15-pass maximum, waits 240 seconds between successful publications, stops on the first failed/unknown child, and never resubmits an unknown transaction. Default synthetic activity is constant 125/100. Explicit `ANTE_UP_QA_SCENARIO=up` uses 150/100; `down` uses 100/100. These are test inputs, not measured attention or EWMA. Stop the previous feed before switching scenarios; one writer lock guards the state directory. A stale feed correctly disables new entries; it must not silently fall back to real data.

The gate's 1-hour reopening is separate and remains held until root's UI deployment and current-data health checks. Root should reuse the existing bounded gate script and preserve 200 outstanding / 100 daily caps.

## Remaining verification

1. New live UI: actual PC/Seeker wallet transactions for curve, indexed spot, LP, Pro long/short, early close + claim. Existing financial full-path evidence is historical (old QA market), not proof of these new UI flows.
2. Graduate this prepared market only at test time; read back reserves/NAV/capabilities after each human action. Do not claim user signature approval through the operator harness.
3. Actual next-Monday maturity/settlement remains unverified on Devnet. Bounded keeper and empty-cycle recovery have local tests; no clock override or artificial accepted settlement is used. Empty-cycle recovery is available only before any active weekly cycle/positions; it cannot reopen LP on an old active cycle.
4. Do not keep synthetic Free records in genuine attention leaderboards; API blocks new synthetic Free entries, but a malicious custom chain client is outside that gate. No synthetic Free records were created here.

## Verification

- API typecheck passed.
- Live-read + consumer-history tests: 8 passed.
- Keeper/API bounded-runner and empty-cycle tests: 22 passed.
- Financial candidate, capital invariant, payoff and distinct-demo-profile tests: 5 passed.
- Bounded feed syntax checked. Live feed and graduation intentionally not started at this checkpoint.
