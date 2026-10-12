# R2 QA handoff — 2026-10-13

## Scope and status

Branch `consumer/r2-qa` in this dedicated clone started at public common contract `9da25f7`. This worker owns only `scripts/consumer-r2-*`, ignored `.runtime/consumer-r2-qa/` outputs, and this handoff. No product source, service, deploy file, HOME, decision note, wallet, provider, or remote branch was changed by this work.

The R2 product modules have not been integrated into this clone yet. **This is a preparation handoff, not R2 acceptance.** The pre-existing checkout reports many unstaged changes outside QA ownership; `git diff --ignore-space-at-eol --numstat` showed no substantive content change in them. They were left untouched and unstaged.

## Delivered

- `scripts/consumer-r2-audit.mjs`: read-only catalog/source/DTO auditor. It reports `PASS/PENDING/FAIL`, writes ignored `.runtime/consumer-r2-qa/audit.json`, and exits nonzero for pending/fail only with `--require-integrated`. It verifies 15 scenario IDs, optional subject/media metadata, separate sample/Live identities, combined Explore catalog, source copy/navigation/Docs/media candidates, and cross-view read-model integrity. Static checks have explicit limits; execution capability and provenance remain pending until integration evidence exists.
- `scripts/consumer-r2-audit.test.mjs`: three targeted tests for full catalog acceptance, missing media/duplicate/mixed identity rejection, and source-state detection.
- `scripts/consumer-r2-matrix.md`: acceptance matrix and exact post-integration data exports, browser, device and evidence requirements.

## Baseline run

From this clone:

```powershell
node --experimental-strip-types --test scripts/consumer-r2-audit.test.mjs tests/consumer/audit.test.mjs tests/consumer/demo.integration.mjs tests/consumer/roundtrip.integration.mjs
node --experimental-strip-types scripts/consumer-r2-audit.mjs
```

The first command passed **15/15**: three new auditor tests and twelve existing synthetic adapter/identity tests. The audit JSON reports **4 PASS, 8 PENDING, 0 FAIL**. Passing baseline items: 15 unique scenarios across five types, stable sample IDs, sample source separation, and the existing sample adapter's 15 markets × four periods = 60 histories, eight fictional profiles and two leaderboards with zero DTO findings. Pending: real-subject/media mapping, one combined catalog with actual Devnet market, public copy, removal of global mode control, Docs wiring, media fallback, execution boundary, and integrated read-model export. This baseline contains old fictional titles, old Free Call copy and the old Live/Demo control; those are expected incomplete implementation states, not accepted R2 behavior.

## Root integration handoff

1. Merge worker modules into the integration clone. Export the actual combined `ConsumerMarket[]` Explore list to ignored `.runtime/consumer-r2-qa/unified-catalog.json`. It must contain all 15 mapped samples plus the current Devnet market with original ID and unique IDs.
2. Export `{markets,histories,profiles,leaderboards}` from the integrated read adapters to ignored `.runtime/consumer-r2-qa/unified-read-model.json`; include all sample periods and rank periods, selected Live finalized IDs, negative/N/A/ongoing outcomes, and empty/missing Live history. No keys or private wallet state.
3. Run:

```powershell
node --experimental-strip-types --test scripts/consumer-r2-audit.test.mjs
node --experimental-strip-types scripts/consumer-r2-audit.mjs --catalog-json .runtime/consumer-r2-qa/unified-catalog.json --read-model-json .runtime/consumer-r2-qa/unified-read-model.json --require-integrated
```

4. Review every source candidate against rendered UI and accessibility labels, then follow `scripts/consumer-r2-matrix.md` for desktop 1440, mobile 390/320, all 15 subject/detail routes, image failure, Docs deep links, old URL compatibility, no global mode toggle, source/execution boundary, and marker→profile→note/chart identity. The old `actual-app-check.mjs` expects a Demo switch and must not be cited as R2 acceptance. A local browser mock is not physical-wallet or finalized-chain evidence.
5. Root supplies the final integration SHA/build for QA's actual App pass. Physical Android Phantom, Seeker Seed Vault, real notes/signatures, and public deployment readback remain root-coordinated; no real transaction was attempted here.

No new product decision was made. Open question for integration: if mapped subjects change any legacy sample IDs, provide an explicit old→new deep-link mapping and demonstrate that sample identities still cannot reach wallet execution or real ranking.
