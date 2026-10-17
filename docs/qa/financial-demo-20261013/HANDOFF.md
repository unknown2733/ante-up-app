# Demo execution readiness — 2026-10-13

## 2026-10-17 cycle 1 maturity preparation

- Finalized Devnet accounts now show cycle `1`, first position opening `1792151359`, maturity `1792368000` (2026-10-19 09:00 KST), two historical positions, zero open positions and no accepted settlement. `scripts/prepare-keeper-scope.mjs` derives and validates this scope from finalized accounts. The former cycle 0 scope is backed up as `keeper-scope.cycle0.backup-20261017.json`; the active `keeper-scope.json` matches cycle 1.
- The old `keeper-run.sh` accidentally passed snapshot `candidates.json` as the settlement journal and failed with `KEEPER_CANDIDATE_INVALID`. Its old version is backed up. The runner now reads a separate `settlements.json` containing `{"settlements":{}}`; the 24 published synthetic snapshot candidates remain untouched. A read-only Keeper pass now returns `state: notDue` with no action.
- Existing synthetic snapshots do not contain the minute observations needed for `HISTORICAL_REPLAY`. `scripts/prepare-trial-settlement.mjs` creates an explicitly `SYNTHETIC_QA` minute history for this isolated market, with a deterministic 100-events/day baseline and 162/day during the last seven days, plus a finalized graduation transaction slot. On 2026-10-17 it prepared 37,722 minutes through `1792212120` in `settlement-observations-v2.json`; the remaining future minutes were not generated. The original constant-100 draft remains separately preserved as `settlement-observations.json` and is not used by the timers. This is controlled QA data, not X Counts or a reconstruction of the 24 previously published snapshots. A virtual complete-window calculation returned a valid NORMAL candidate with price `1.436569 tUSD`, close to the trial's last published `1.44 tUSD`.
- User systemd one-shot timers with linger enabled are active: `ante-up-trial-data-finalize.timer` at 2026-10-19 09:01 KST appends only the elapsed minutes; `ante-up-trial-settlement-freeze.timer` at 09:16 KST freezes a normal candidate only if the complete timely history exists, then runs Keeper in **plan mode only**. They send no on-chain transaction. Check `systemctl --user status` and `journalctl --user -u ...` after each timer. A failed/missed 09:01 run must not be repaired by backdating observations after the 09:15 cutoff.
- The current cycle has **zero open Pro positions**, so a successful maturity pass can verify candidate acceptance and LP window renewal later, but cannot demonstrate `SETTLE_PRO` for a surviving position. Keeper execution is not scheduled. A dormant server-side `trial-keeper-execute-one.sh` requires `ANTE_UP_ALLOW_TRIAL_ONCHAIN=yes`, one frozen NORMAL cycle-1 candidate and the durable attempt journal; it has been syntax checked and its disabled state tested. After the freeze, inspect the candidate hash, timer logs, chain state, signer identity and Devnet SOL, then invoke it one instruction at a time with finalized readback.

## 2026-10-16 controlled Devnet finance retest

The owner chose the separately labelled synthetic Devnet market for controlled finance verification. It remains `SYNTHETIC_QA` in the public registry; its operator-generated observations are not X Counts. Real `solana` remains on its organic curve.

- Market `CFAAiVZD1PGcRrPEikjAZjtmnc2tNnp1g7Jk5RdpK2SG` was already graduated. A new synthetic observation was finalized without creating another market or adding graduation capital.
- A read-only Keeper pass returned `RECOVER_LP_WINDOW ready` for the empty cycle. The one-pass recovery was submitted as `5SH28o9Dx8Mrdv5BrPWR8tUVVGeRyvjZhWSvoJoCnm8721ePgVKLNpydMDWjRF4Uc8kmZEcJUUKcgxFZy7kr7Ri3` and the API reported `INITIAL_LP`.
- The operator trial wallet deposited and withdrew 10 tUSD. Both transactions finalized: `8Q33j8vA1jsgEsBB6YkGyWWS4hBopmUMcMkqu8bcQSZwXr4XnmnjdVYQpixUsJMWMPt6xQKdKqEczQdS293SGr6` and `2pQzgLB3EEadpfWj6aFbGiaxNZTMcnSKRpd9ZUaVitXw5s8zgCYuQpkxZf8PRb3TWWRopAfJxu4cMHmGBP3spxYD`. Trial wallet LP shares returned to zero.
- The same wallet bought and sold one keyword token. Both transactions finalized: `5bytEBpioMRtanUingMRFBiYZnsKCF5qQjP1svW6crryEX5Rc9TzwXr4XnmnjdVYQpixUsJMWMPt6xQKdKqEczQdS293SGr6` and `34PxJKscLUJaNSnDjWXj813MJY72XtxHG7Zq4PndeZJpsBGGj6c2ci6CDr1NAzZv8G7fPQjBmB5PRiymhxcHx28`. Trial wallet token balance returned to the prior quantity.
- `scripts/qa-finance-devnet.mjs` now has bounded `trial-spot`, `trial-lp`, and `trial-pro` stages, available only with the explicit demo profile. Each transaction retains its signed signature in the durable journal before submission; unknown outcomes stop rather than retry.
- The first `trial-pro` attempt did not land: after the initial observation became stale, validity generation advanced from 2 to 3 while LP generation remained 2. `open_pro` correctly rejected it with `WrongPhase`. The recorded signature was absent after its last valid block height and no position was created; the old journal entry remains intact.
- A finite synthetic feed resumed at 240-second intervals. A Keeper bug was exposed: reconciling an older finalized `RECOVER_LP_WINDOW` attempt returned `unknown`, blocking a new generation. The fix skips finalized older attempts but still blocks pending or unknown ones; a regression test covers both cases. A new recovery was submitted as `AadhkxPKkt2giPpQ8PN8Ga7pynaDet69GEBJdjSQqHcZm4oNdGGnUVZPcE8h4B7pq6viWHfies3jTsTzsJ8GiuM`. On-chain readback showed `lpGeneration=validityGeneration=3`, with a new 900-second window ending at chain time `1792151333`.

- After the actual LP window ended, the trial wallet opened one 100 tUSD collateral / 5x long and one 100 tUSD collateral / 5x short. Both opens finalized: `55KUPVS5XC5c4PGVMx9tmtaAxugmoFmsi2qz4TEE2P6i8Ama62vfbVdTKy53Xns4hAxphbLpA67TR4rDvonSR9si` and `5ZikRL9rW2CerXDePJSTKhLn6fYiWBM9XfZK7PjAV9Vytis2zE3WuqEujCryvcU1ysQnQVC7mmAkpLtdUS9yx2v3`.
- Exit observation sequence 24 finalized at operator-generated activity 150 versus entry 125, moving the contract price from 1.20 to 1.44 tUSD. Long and short early closes finalized (`rANdgMbQN3eqF15pRsrJEENrJBnabyKkZi3UFxDhc4Xy5woraET6BZemJePqcyE5e3ftJhus6PQpRXcSgRgGkNo`, `55TbWLdnjbBDcjBV7LFg9DzbRjdayEW7MUtFRoL5wzXZxfCdMHaAPwqBYeS8ReGvmd6Gk1gwkotCWzRFFJbgkNQv`). Claims finalized (`4AWpB5zWmHmD1iqSf9CXmX87R19A9wKuieQr18M1NWJatou247SCF5Kab5s6rEru5papQn7x996tJckUf22abFz`, `4niwNchwxyFcP3BwF3VM88522Au7e3xNqp8F8YvP6nfjZeCfzxezppJcRzzbrXV2taKAQCGAfeBxeoFnPZANhsN8`). On-chain payout matched the reference formula: 200 tUSD long, 0 tUSD short, with documented prepaid-fee refunds. Final ledger: 8,300.802033 tUSD assets, 0 Pro reserve, 0 other reserve, 0 open positions, 3,000.802033 tUSD free after spot reserve and buffer.

This verifies bounded 5x long/short early-close and claim execution on the labelled Devnet trial. The normal weekly maturity (`1792368000`) remains a separate verification; this early-close trial does not demonstrate automatic settlement at maturity. Physical PC/Seeker wallet UI is also outside this operator harness.

## Historical 2026-10-13 preparation checkpoint

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

## Historical execution plan (graduation completed before the 2026-10-16 retest)

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

The gate's 1-hour reopening is separate and remains held until root's UI deployment and current-data health checks. Use `deploy/demo-admission-window.sh` inside a container with `/run/secrets/rpc.url`, `/run/secrets/admin.json`, and `/state` mounted. It checks real solana freshness and preserves 200 outstanding / 100 daily caps. Set Docker stop grace to at least 60 seconds. It journals under this new demo state directory and closes on normal completion or TERM. Do not reuse `device-android-window.sh` unchanged: its hardcoded old open journal only confirms the historical transaction rather than opening a new window. A forced kill/host loss can prevent the close trap; root must read back the gate and reconcile the close journal.

## Remaining verification

1. New live UI: actual PC/Seeker wallet transactions for curve, indexed spot, LP, Pro long/short, early close + claim. Existing financial full-path evidence is historical (old QA market), not proof of these new UI flows.
2. Graduation and the bounded operator finance roundtrip are complete on this labelled trial market. Do not claim human wallet signature approval through the operator harness; repeat the relevant flows in the current PC/Seeker UI when devices are available.
3. Actual next-Monday maturity/settlement remains unverified on Devnet. Bounded keeper and empty-cycle recovery have local tests; no clock override or artificial accepted settlement is used. Empty-cycle recovery is available only before any active weekly cycle/positions; it cannot reopen LP on an old active cycle.
4. Do not keep synthetic Free records in genuine attention leaderboards; API blocks new synthetic Free entries, but a malicious custom chain client is outside that gate. No synthetic Free records were created here.

## Verification

- API typecheck passed.
- Live-read + consumer-history tests: 8 passed.
- Keeper/API bounded-runner and empty-cycle tests: 22 passed.
- Financial candidate, capital invariant, payoff and distinct-demo-profile tests: 5 passed.
- Bounded feed syntax checked. Live feed and graduation intentionally not started at this checkpoint.
