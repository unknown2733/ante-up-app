# R2 integrated App QA handoff — 2026-10-13 KST

## Scope

Branch `consumer/r2-qa` owns only `scripts/consumer-r2-*`, ignored `.runtime/consumer-r2-qa/` evidence, and this handoff. QA did not change product source, deploy configuration, HOME, wallet state, or remote branches. The integration clone is `../ante-up-r2-integration`. Many unrelated files in the QA clone show line-ending-only unstaged changes; they were left untouched and unstaged.

## Reproducible checks

- `node --experimental-strip-types --test scripts/consumer-r2-audit.test.mjs`: **4/4 passed**. Cases include malformed catalog identity and six rendered regression examples that fail before correction and pass after.
- `node scripts/consumer-r2-export-mock.mjs --integration-root ../ante-up-r2-integration`: exports 15 integrated sample markets and one **local QA Live shell** into ignored `integrated-mock-catalog.json` and `integrated-mock-read-model.json`. The shell has no observations/actions and is not a real Devnet market.
- Run `consumer-r2-audit.mjs` from the integration clone against those exports: **13 PASS, 9 PENDING, 0 FAIL**. [Audit output](../ante-up-r2-integration/.runtime/consumer-r2-qa/audit.json). The nine pending gates need actual rendered evidence or execution/provenance review; the mock does not satisfy `--require-integrated`.
- `npm --prefix apps/web run build` on integrated `2fd5de0` with `VITE_API_BASE_URL=/api`, `VITE_ALLOW_FIXTURE_API=true`: passed. Output CSS `index-BkSLOa5l.css`, JS `index-DKPTRSQE.js`.

## Browser evidence

The browser runner starts a same-process, read-only local App server, intercepts all requests, blocks writes and external requests by default, and never connects or signs a wallet. Captures include DOM state, overflow, labels, screenshots, requests, and browser errors. Reports are under ignored `.runtime/consumer-r2-qa/` in this QA clone.

| Integrated source | Report | Result |
| --- | --- | --- |
| `c771690` | [Full default pass](.runtime/consumer-r2-qa/browser-C6UuSC/report.json) | 91 views, 0 failures, 0 blocked requests, 0 unexpected JS errors; 1440×900, 390×844, 320×568; Explore, 15 sample details per viewport, Docs topics and click journeys. |
| `6055e17` | [15-detail media pass](.runtime/consumer-r2-qa/browser-UIYUVF/report.json) | 16 views, 0 failures; all 15 sample detail images had `naturalWidth > 0`. |
| `6055e17` | [Bounded Explore image pass](.runtime/consumer-r2-qa/browser-amvR4L/report.json) | 2 views, 0 failures; all 15 Explore catalog images finished loading within the bounded wait and had `naturalWidth > 0`. |
| `2fd5de0` | [Final targeted smoke](.runtime/consumer-r2-qa/browser-QoKGQn/report.json) | 28 views, 0 failures, 0 blocked requests, 0 unexpected browser errors; latest profile badge, unknown and malformed Docs client routes, mobile recovery link and three viewport sizes. An independent [repeat](.runtime/consumer-r2-qa/browser-4jWggU/report.json) also passed 28/28. |

The [latest mobile profile screenshot](.runtime/consumer-r2-qa/browser-4jWggU/mobile-390-journey-profile-note.png) shows the sample source badge legibly in two lines. A previous smoke found the unknown Docs page's “Browse all Docs” link had a 20px mobile target. Product owner fixed it in `2fd5de0`; the final pass has no small mobile standalone targets on unknown or malformed Docs pages. The local QA server intentionally returns HTTP 400 to a malformed percent-encoded URL. The App's own fallback was checked by client-side history navigation without that server request. One earlier cross-sandbox Chromium/server run produced connection error pages and was discarded; none of its captures are acceptance evidence.

The media pass permits only HTTPS GET image requests to thumbnail origins found in the catalog, strips cookie/auth headers, and verifies the actual pixels loaded. Media licensing and continued availability still need source-owner review. Sample image failure fallback was observed in the default CSP-blocked pass. The read-only QA Live shell must not be conflated with the real public API market. Root separately read the public Devnet API, including market ID `7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT`; that result belongs in root's independent provenance evidence.

## Remaining acceptance work

The browser and DTO passes do not prove actual wallet/chain behavior, physical Phantom/Seeker flows, finalized Live identity, media rights, or human note-to-subject review. The auditor's rendered regression input (`activityRows`, SVG avatar, market media, note reviews, Live profile copy, Docs pages) remains pending unless captured from the final App and reviewed as specified in [the matrix](scripts/consumer-r2-matrix.md). Do not mark these gates PASS by inventing Boolean evidence. Root owns controlled Devnet/device verification and final release decision.
