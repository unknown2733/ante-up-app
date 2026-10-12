# Unified consumer R2 QA matrix

This matrix is for the R2 integrated build. Baseline checks on parent `9da25f7` prove only that the existing 15 synthetic scenarios and identity rules still work. They do **not** certify the new catalog, copy, media, Docs, or wallet behavior.

## Evidence columns

Record source SHA, built asset hash, local time/timezone, environment, viewport/device, route and stable ID, source mode and source URL/as-of, observed result, screenshot or redacted log, and `PASS/FAIL/PENDING/NOT_RUN`. A generated image URL alone is not proof of permitted media use. Keep public real-subject evidence separate from synthetic chart/action data.

| Gate | Check and expected result | Baseline at 9da25f7 | Integrated evidence |
| --- | --- | --- | --- |
| Catalog | One Explore list has 15 real-subject sample mappings and the existing Devnet market; stable IDs or explicit migration, no duplicates | PENDING: 15 fictional scenarios, no combined list | Export listMarkets DTOs; run `consumer-r2-audit.mjs --catalog-json`; inspect desktop/mobile discovery and all 16 detail routes |
| Provenance | Official subject link, creator when applicable, artwork source/alt; Sample history and Example activity never presented as observed or the subject's own statements | PENDING: no real-subject metadata | DTO audit, source links, screenshot and accessible name on each detail |
| Artwork/fallback | Every cover/avatar loads or has a readable failure fallback; no fictional actor assigned a real-person photo | PENDING: media module absent | Break one image URL locally and inspect fallback; check all 15 images plus source/attribution record |
| Navigation | No global Live/Demo mode control in desktop/mobile; old `?mode` and detail links resolve without changing provenance | PENDING: old switch still present | Keyboard/tap navigation, direct URL reload, query compatibility, no duplicate market |
| Execution boundary | Sample IDs cannot initiate wallet prepare, faucet, Pro, LP, SAS, or live ranking; real Devnet market retains authorization and finality path | PENDING: integration not present | Read-only browser network trace and API identity checks; later root-coordinated real-wallet run |
| Chip language | No customer-facing “Free Call”, internal actor/fixture/admission labels; Place chip/Take back chip and result semantics consistent; paid controls retain financial names | PENDING: old copy present | Rendered DOM, accessible controls/errors/empty states, source candidate review, English audit |
| Chart→profile→note | Action/market/actor/time IDs agree through marker, profile and note; negative, N/A, pending, gaps and 1D/1W/1M/ALL remain coherent | Existing synthetic adapter checks pass; R2 PENDING | Export read model for snapshot audit; browser marker→profile→chart and deep-link reload |
| Closed record state | A placement event whose record has a later close is never labeled Active/Open in Activity; show the historical placement and final result distinctly | PENDING: legacy source labels every `CALL_OPEN` row Open | Render every closed sample profile, export `activityRows`, compare action/record IDs; regression auditor fails an Active placement |
| SVG avatar | A `data:image/svg+xml` profile avatar displays pixels or a visible generated fallback; no broken icon | PENDING: new media module absent | Render SVG data URI in Chromium and export `src,naturalWidth,fallbackVisible` |
| App market media | App passes subject art/title metadata into Activity/profile, and each row matches the selected real subject | PENDING: `marketMedia` wiring absent | Inspect all 15 rendered subject rows and fallback; export `marketMedia` with manual title/art review |
| Real-subject notes | Every synthetic note fits its newly mapped real subject and remains attributed only to an example actor | PENDING: old scenario prose unreviewed | Review all 15 markets, export `noteReviews` with the specific evidence and any mismatch |
| Live public profile copy | No “Free Call” in rendered Live profile body or accessible labels | PENDING: legacy source has “Public free calls” | Capture a Live `/u/:id` page and export visible text/labels; regression auditor rejects residual copy |
| Docs | `/docs` and `/docs/:slug` open without wallet on desktop/mobile; app navigation visible, internal links and factual limitations correct | PENDING: module/route absent | Direct-link GET/reload, all topic links, 390px navigation and scroll/overflow |
| Docs completeness | No TODO/TBD/placeholder/coming-soon content in app Docs; every deep link has substantive text and accessible navigation | PENDING: docs module absent | Source scan and rendered `docsPages` across home + at least seven topics |
| States and accessibility | Empty live API, missing market/history, media/API errors recover clearly; no broken images, visible Hangul, unnamed controls or horizontal overflow | PENDING for R2 | 1440×900, 390×844, 320×568 browser screenshots; keyboard order and touch hit areas |
| Physical wallet | Phantom desktop/Android and Seeker preserve connect/cancel/UNKNOWN, open/close chip, note ownership/version and Pro/LP/faucet boundaries | NOT_RUN for R2 | Root schedules controlled Devnet/device test with request ID, signature/finality and safe evidence |

## Commands after integration

From the R2 repository root, Node 24+:

```powershell
node --experimental-strip-types --test scripts/consumer-r2-audit.test.mjs
node --experimental-strip-types scripts/consumer-r2-audit.mjs --catalog-json .runtime/consumer-r2-qa/unified-catalog.json --read-model-json .runtime/consumer-r2-qa/unified-read-model.json --regression-json .runtime/consumer-r2-qa/rendered-regressions.json --require-integrated
node scripts/consumer-r2-browser.mjs --url http://127.0.0.1:5194 --catalog-json .runtime/consumer-r2-qa/unified-catalog.json --source-sha FINAL_SHA
```

`unified-catalog.json` is the actual combined Explore `ConsumerMarket[]`; `unified-read-model.json` has `{markets,histories,profiles,leaderboards}` from both read adapters. Include all 15 samples, all four periods, both ranking periods, an empty/missing Live history, and selected finalized Live IDs. The auditor writes `.runtime/consumer-r2-qa/audit.json`; it does not call paid APIs or write application data. Without the JSON exports, `PENDING` is expected and `--require-integrated` exits nonzero. Root must confirm live market identity and sampled times against the deployed read API/finalized chain; a DTO snapshot alone cannot prove origin.

`rendered-regressions.json` is evidence collected from the integrated App, not an assertion file to fill with guessed booleans. Its fields are `activityRows:[{actionId,visibleState}]` for every closed sample placement; `svgAvatar:{src,naturalWidth,fallbackVisible}`; `marketMedia:[{marketId,subjectTitle,imageVisible,fallbackVisible,reviewedSubject}]` for all 15; `noteReviews:[{marketId,matched,evidence}]` after human subject-note review; `liveProfile:{route,visibleText,accessibleLabels}`; and `docsPages:[{route,visibleText,linkAccessible}]` for home plus at least seven topics. Missing evidence remains `PENDING`. The unit test reproduces the old Active placement, broken SVG avatar, wrong media title, mismatched note, Live Free Call copy, and Docs placeholder as `FAIL`, then checks corrected examples as `PASS`.

`consumer-r2-browser.mjs` accepts only a local HTTP server, blocks writes/external requests in Chromium, and captures Explore, 15 sample details, Docs home/topic links at 1440×900, 390×844, and 320×568. It requires a root-owned integrated local server and has not run against R2 yet. Run source English audit and module tests separately. The old `apps/web/qa/consumer/actual-app-check.mjs` expects a Demo switch and is **not** an R2 acceptance runner. Browser mocks/emulated touch cannot replace Android Phantom or Seeker Seed Vault evidence. Never click wallet write controls in a read-only browser pass.
