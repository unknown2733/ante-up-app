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

## Regression acceptance addendum

QA follow-up added six explicit R2 regression gates without touching product files: closed record placement rows must not remain Active/Open; SVG data-URI avatars must render or show a stable fallback; App must wire real-subject `marketMedia` into profile/Activity; Docs must have no visible placeholder; synthetic notes must fit their mapped real subjects; and Live public profile text/accessibility labels must not say Free Call. These are separate from the existing DTO snapshot, which can pass while the UI is wrong.

`scripts/consumer-r2-audit.mjs` now accepts `--regression-json` with rendered evidence fields documented in [the matrix](scripts/consumer-r2-matrix.md). Missing evidence is `PENDING`; known bad evidence is `FAIL`; only checked evidence is `PASS`. The baseline audit is **4 PASS, 18 PENDING, 0 FAIL**. Its source-risk detail detects the old `CALL_OPEN ? 'Open'` presentation and the old Live-profile Free Call copy, but these remain pending R2 integration rather than reporting the unfinished product as a final failure. The targeted test injects six bad examples and six corrected examples and confirms FAIL→PASS; the full baseline suite now passes **16/16**. The new `consumer-r2-browser.mjs` is prepared for root's integrated local server and catalog; it requires a loopback URL, blocks writes and external requests, and captures 1440×900, 390×844 and 320×568. Its syntax and non-local URL rejection were checked; it has **not** been run on an R2 App.

After root sends the integrated source SHA and local server/read-model exports, rerun the commands in the matrix and review the browser screenshots plus rendered regression evidence. In particular, an SVG fallback Boolean or note-match Boolean in a hand-authored JSON file is not independently sufficient; capture the actual image state and review each note alongside the mapped subject. No R2 final browser or wallet claim is made by this handoff.

## Follow-up QA gates before the first R2 integration run

The auditor now keeps six regression areas separate from the old synthetic DTO PASS: closed placement state, SVG avatar data/fallback, App market media wiring, Docs placeholders, real-subject note fit, and Live public-profile Free Call copy. `--regression-json` takes rendered evidence; omitted fields are **PENDING**. The new targeted test supplies bad and corrected evidence for all six and proves FAIL→PASS. The baseline audit is **4 PASS, 18 PENDING, 0 FAIL**; both old `CALL_OPEN ? 'Open'` presentation and Live-profile Free Call source risks are explicitly reported as pending. The augmented old-adapter/new-QA suite is **16/16 passed**, which certifies the auditor and existing synthetic data only.

`scripts/consumer-r2-browser.mjs` is ready for a root-owned local server: it restricts URLs to loopback, intercepts and blocks browser writes/external requests, and captures Explore, all 15 sample details, and Docs topics at 1440×900, 390×844, and 320×568. A nine-view `--smoke` on an **old pre-R2 dist** verified navigation/screenshots/request interception and deliberately exited 1 on its obsolete Korean/missing-R2 UI; [smoke report](.runtime/consumer-r2-qa/browser-ccXb3x/report.json). This report must never be called an R2 App result. Syntax check and non-local URL rejection also passed.

Root has since identified the first integration clone at `../ante-up-r2-integration` for read-only QA; its final SHA and UI follow-up were still pending at this handoff update. Next: run source/catalog/DTO checks there, then final local browser pass after the UI follow-up. Product edits remain with their owners.
