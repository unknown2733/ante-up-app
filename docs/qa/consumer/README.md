# Consumer QA handoff

Status: **harness ready; final integrated QA pending**. This directory does not certify the current app. Run final checks only after U1–U5 and the English shell are integrated. Keep real device evidence separate from synthetic test results.

## Automated checks

From repository root, with Node 22+:

```powershell
node --test tests/consumer/*.test.mjs
node apps/web/qa/consumer/english-audit.mjs
node apps/web/qa/consumer/audit-cli.mjs .codex-work/qa-snapshots/consumer.json
```

The English audit scans `index.html` and all `.ts/.tsx/.html` files under `apps/web/src`. It reports Hangul candidates, `html lang`, description and favicon link. Review each hit: code comments and test fixtures can be false positives; wallet app chrome is outside product copy. The snapshot command is an offline check. Root should export a read-only `ConsumerReadApi` sample into the following shape from both live and demo adapters, without keys, access tokens or private profile data:

```json
{
  "markets": [],
  "histories": [],
  "profiles": [],
  "leaderboards": []
}
```

Use all four periods for at least one market, include an empty-history live market and markets with negative, ongoing and N/A outcomes, plus 7D and ALL ranks. Each array element is the DTO in `contracts/consumer.ts`. The validator checks mode separation, IDs, decimal strings, ordered points and gaps, action/series links, note ownership/time/version/proof boundary, public paid-activity exclusion, mean returns and all-time rank alignment. It cannot prove that a claimed live point came from a real observation; manually reconcile selected IDs/timestamps against finalized API/chain evidence. It cannot establish financial arithmetic from display numbers alone.

For rendered checks, open `apps/web/qa/consumer/browser-probe.js` and paste its contents into DevTools Console on the selected page and viewport. Record the returned object. It only reads the current DOM; no wallet or network action. Check any flagged small target in context, since neighboring label/area may enlarge the effective target. Repeat on discovery, market, profile, leaderboard, record, wallet and failure states. A static probe does not establish keyboard order or chart touch behavior.

## Isolated cross-module preview

When the UI, charts, presets and social worker commits are available in sibling clones, run these from the QA clone:

```powershell
node apps/web/qa/consumer/stage-preview.mjs
node --experimental-strip-types --test .runtime/consumer-preview/run-XXXX/tests/consumer/*.integration.mjs
node .runtime/consumer-preview/run-XXXX/apps/web/qa/consumer/english-audit.mjs
node apps/web/qa/consumer/visual-check.mjs .runtime/consumer-preview/run-XXXX
```

Replace `run-XXXX` with the path printed by staging. The script reads each sibling clone's committed HEAD and builds an ignored preview in this QA clone; `provenance.json` records exact SHAs. It never writes to another clone or the server. The two integration tests exercise all Demo periods/profiles/ranks and actual chart-history → public-social-profile → authenticated-note-service → history readback with the shared action ID. The visual script uses installed local Chromium, starts a temporary localhost port 4182, records 1440×900 and 390×844 screenshots plus `visual-report.json`, and checks overflow, broken images, language, console errors and chart marker mouse/touch selection. It may require normal host execution approval for Chromium. Review `smallTouchTargets` in the report manually; a nested input can be smaller than its clickable label. This preview has only fictional Demo data and no wallet controls. It is evidence about the combined worker components, not the production app or physical device.

## Built App browser run after root integration

Root supplies a dedicated local QA `apps/web/dist` built from the final App/API integration SHA with `VITE_API_BASE_URL=/api`, `VITE_ALLOW_FIXTURE_API=true`, and no signing RPC. Do not reuse a production bundle with an external API URL. The browser runner serves that directory on 127.0.0.1:4182 with `serve-app.mjs`; `/api/v1/*` is a read-only mock API, every write returns 405, and a same-origin Content Security Policy prevents external fetches. The default Live consumer envelope uses `devnet` mode with an empty market list; only the direct `fixture:sol` legacy route gets an explicitly labeled QA market shell with zero points and actions so disconnected Pro/Liquidity tabs can render. Explicit `mode=DEMO` mock reads have a `fixture` envelope and deterministic Demo DTOs; the App's Demo adapter is local. This supplies no synthetic Live observations, trades or rankings. The legacy fixture GET routes support disconnected faucet, Pro/Liquidity, empty/error and older record views.

```powershell
node --experimental-strip-types --test tests/consumer/readonly-mock.test.mjs tests/consumer/serve-app.test.mjs
node apps/web/qa/consumer/actual-app-check.mjs PATH_TO_QA_DIST FINAL_SOURCE_SHA --require-consumer
```

The second command creates an ignored `.runtime/actual-app-qa/run-*/actual-app-report.json` and screenshots. It checks 1440×900 and 390×844 discovery, legacy market/Pro/LP, leaderboard, disconnected faucet, activity, registration and missing-market routes; then tries Demo market → chart → marker → `/u/:actor?action=:id` profile/note → chart action link and deep-link reload, rank → profile and Live empty-state switch. It records visible Hangul, title/description, favicon metadata and local GET status, unnamed controls, horizontal overflow, broken images, small touch targets, browser errors, attempted writes and external requests. The supplied source SHA is a label; the report independently hashes the served dist. Keep the source SHA and dist hash together in the integration evidence. A missing component is `NOT_RUN` before App wiring and a failure with `--require-consumer` after wiring.

This local browser run still cannot establish live API provenance, real wallet signature handling, physical Android touch behavior or finalized chain outcomes. Run the final matrix below against the integrated deployment and devices afterward.

## Final matrix

Evidence columns for each row: build SHA; local time and timezone; environment/browser/version; device and viewport; route/market/mode; wallet/network or disconnected; action/request ID when applicable; observed result; API/chain source; screenshot or safe console excerpt; status `PASS/FAIL/BLOCKED/NOT_RUN`. Never place a seed phrase, auth token or full private browser storage in evidence. Use `NOT_RUN` for absent integration or unavailable device.

| Area | PC web | Android Chrome + Phantom | Seeker Chrome + Seed Vault | Acceptance evidence |
| --- | --- | --- | --- | --- |
| Discovery → market → chart, 1D/1W/1M/ALL | Pending | Pending | Pending | Correct market/period, curve vs reference labels, missing history visible as gap, no fabricated live candles |
| Marker → action → profile/note and back | Pending | Pending | Pending | Same event ID/time/actor/market across views; overlapping markers selectable by hover, tap, keyboard |
| Demo multieweek keyword/video/track/album | Pending | Pending | Pending | Distinct synthetic actors/markets, negative and N/A examples; visible Demo label on every route; no real wallet execution |
| Live vs Demo switch and isolation | Pending | Pending | Pending | No shared rank, balance, action, proof link or executable Demo quote; switching back preserves correct Live identity |
| Free call open/close and own history | Pending | Pending | Pending | Quote/signature/finality/request recheck; N/A and losses displayed; previously verified flow still works in new UI |
| Buy/sell and own financial history | Pending | Pending | Pending | Existing quote/fee/finality path, no chart-price settlement shortcut; paid actions absent from public profile |
| Public leaderboard/profile | Pending | Pending | Pending | Valid finalized closed-call arithmetic mean, 7D/ALL, count, ties, ongoing/N/A excluded; paid PnL separate |
| Notes | Pending | Pending | Pending | 280 code points, author ownership, action ref, server time, added-later and edited labels, plain text, no implied SAS coverage |
| Wallet disconnected/changed/cancelled/response lost | Pending | Pending | Pending | No false success or duplicate submission; UNKNOWN recheck returns finalized/failed evidence before retry |
| Loading/empty/low activity/outage/error | Pending | Pending | Pending | Natural English reason and recovery action, no zeros substituted for unavailable values |
| Navigation/branding/metadata | Pending | Pending | Pending | Logo, colors, favicon request, title/description, focus order, 320px and larger without clipping |
| English and accessibility | Pending | Pending | Pending | Buttons, labels, status, dates/units, wallet errors and proof details read naturally; keyboard and touch usable |

For actions that require a signature, root schedules a single test window and verifies actual finalized results. This QA harness does not trigger faucet, quote, transaction, paid API, USB or wallet approval. Prior device reports are regression references, not evidence that the newly integrated UI passes.

## Responsive and interaction run

Check 320×568, 360×800, 393×852, 768×1024, 1280×800, and a wide desktop viewport. At each size inspect horizontal overflow, chart axis/tooltip clipping, overlapping markers, bottom navigation, long English labels and wallet addresses, scroll retention after route changes, and Android keyboard viewport. Use the browser probe on every primary route and log exceptions with a screenshot. Test keyboard only from Tab/Shift+Tab/Enter/Space/Escape: visible focus, logical order, marker selection, modal close, no keyboard trap. On mobile use real tap/long press/scroll to distinguish marker selection from chart pan and page scroll; emulation alone is not device evidence.

## Copy review rubric

Use `Live Devnet`, `Demo`, `Make a call`, `Close call`, `Buy`, `Sell`, `Pro`, `Liquidity`, `Proof`. A call is a free choice, not a trade fill. Quote/receipt price and fees must keep their own labels. Prefer “No price history yet” over showing zero; “No eligible closed calls” over an empty rank; “Added later” and “Edited” on notes where appropriate. Avoid implementation jargon (`fixture`, `contract`, `admission`, `schemaVersion`) as primary page copy. Confirm backend error codes are mapped to user action and distinguish signature rejection from pending confirmation. SAS proof scope must not imply the optional note was attested.
