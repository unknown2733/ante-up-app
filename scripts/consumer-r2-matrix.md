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
| Docs | `/docs` and `/docs/:slug` open without wallet on desktop/mobile; app navigation visible, internal links and factual limitations correct | PENDING: module/route absent | Direct-link GET/reload, all topic links, 390px navigation and scroll/overflow |
| States and accessibility | Empty live API, missing market/history, media/API errors recover clearly; no broken images, visible Hangul, unnamed controls or horizontal overflow | PENDING for R2 | 1440×900, 390×844, 320×568 browser screenshots; keyboard order and touch hit areas |
| Physical wallet | Phantom desktop/Android and Seeker preserve connect/cancel/UNKNOWN, open/close chip, note ownership/version and Pro/LP/faucet boundaries | NOT_RUN for R2 | Root schedules controlled Devnet/device test with request ID, signature/finality and safe evidence |

## Commands after integration

From the R2 repository root, Node 24+:

```powershell
node --experimental-strip-types --test scripts/consumer-r2-audit.test.mjs
node --experimental-strip-types scripts/consumer-r2-audit.mjs --catalog-json .runtime/consumer-r2-qa/unified-catalog.json --read-model-json .runtime/consumer-r2-qa/unified-read-model.json --require-integrated
```

`unified-catalog.json` is the actual combined Explore `ConsumerMarket[]`; `unified-read-model.json` has `{markets,histories,profiles,leaderboards}` from both read adapters. Include all 15 samples, all four periods, both ranking periods, an empty/missing Live history, and selected finalized Live IDs. The auditor writes `.runtime/consumer-r2-qa/audit.json`; it does not call paid APIs or write application data. Without both JSON exports, `PENDING` is expected and `--require-integrated` exits nonzero. Root must confirm live market identity and sampled times against the deployed read API/finalized chain; a DTO snapshot alone cannot prove origin.

Run source English audit and current module tests separately, then browse the integrated local build and record screenshots/DOM probes. The old `apps/web/qa/consumer/actual-app-check.mjs` expects a Demo switch and is **not** an R2 acceptance runner. Browser mocks/emulated touch cannot replace Android Phantom or Seeker Seed Vault evidence. Never click wallet write controls in a read-only browser pass.
