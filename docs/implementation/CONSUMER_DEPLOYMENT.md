# Consumer App/API deployment — 2026-10-13

## Scope

Integrate the consumer UI, charts, Demo catalog, public free-call social views and authenticated notes with the existing Devnet API. Preserve financial contracts, wallet verification, collection limits and evidence budgets. The new price sampler reads finalized accounts; it makes no X API requests and signs no transactions.

## Server layout

- Compose directory: `/srv/example-app/builds/always-on-20261012/deploy`.
- State: `/srv/example-app/builds/service-state`.
- Consumer sampler DB: `/state/live-smoke/price-history.sqlite` inside containers.
- API configuration: `ANTE_UP_PRICE_DB=/state/live-smoke/price-history.sqlite`.
- Overlay order: `compose.yml`, `compose.parallel.yml`, `compose.evidence.yml`, `compose.price-history.yml`, `compose.consumer.yml`.
- Supply both existing `.env` and `evidence-budget.env` files. Never log their contents. Select explicit services with `--no-deps`; do not recreate the collector or evidence worker as a side effect.

## Recovery points

Before the API change, SQLite's online backup API copied `index.sqlite` and `price-history.sqlite` to `/srv/example-app/builds/service-state/backups/consumer-20261012T180100Z`. Both copies passed `PRAGMA quick_check`. This is a per-database snapshot, not a globally atomic snapshot across databases.

Prior images: API `ante-up:clock-timing-20261013`; web `ante-up:wallet-reconcile-20261013`. The consumer schema adds note tables without changing old financial tables. Application rollback should retain the current database, including any new notes. Do not automatically restore the backup over subsequent live records. To roll back images, provide a final overlay specifying these exact images and recreate only API/web.

## Activation and verification performed

1. Baseline consumer modules were merged at `248367f`; deployment overlay at `436e622`.
2. `consumer-base-20261013` built on Linux. Dependency lockfiles matched the existing base. The clean-build alternative remains `deploy/Dockerfile`.
3. Price sampler dry-run returned one valid market. One-shot stored its first real observation; immediate repeated bucket stored zero. Follow mode stored subsequent observations at five-minute boundaries. Container health returned OK.
4. API branch `a2dd8d8` merged into root `e52c545`. Linux API/consumer checks passed 77, skipped one optional test. `consumer-api-20261013` replaced only API.
5. The first immediate probe preceded socket startup and returned connection refused; the retry after the listening log passed. No application error or rollback occurred.
6. Local and public HTTPS API probes passed. At 18:06 UTC: one actual `solana` market, 10 free actions, five profiles, 11 curve price points, 68 attention-index points, both ranking periods. Cross-view audit returned no findings. An unauthenticated note write returned rejection and wrote no note.
7. UI branch `28cd28f` merged into root `fd58e83`. Linux integration checks passed 210 with two unavailable native checks skipped, and 40 web checks passed. These checks do not replace wallet/device approval testing.

## Read-only deployment check

`node scripts/verify-consumer-deployment.mjs https://ante-up.fun/api` checks real read envelopes, identities, chart/profile/rank consistency and authentication rejection. It requests no financial operation, creates no wallet session and submits no chain transaction. The unauthenticated PUT is an intentional rejected request.

## Final release

- Source shipped: `8023388` (product code is the same as browser-tested `74c0d9d`; the difference is the configured-favicon verification script). Image `ante-up:consumer-20261013`, SHA-256 `802abf25f27d0d14a57d4ff4207456b5f24090f021150dfcd9a6e0cbb7878f77`.
- API/web/price-history now run this image. Existing X collector, indexer and evidence images and their limits were preserved.
- UI `343ad91` adds visible-tab 60-second history refresh, cancellation and stale status while keeping chart/financial inputs. Mobile controls and chart/funding links were enlarged. Root `7c1856e` fixes the generated client's bracket-form NODE_ENV access in Vite development; a direct development transform confirmed replacement.
- Final Linux build passed and web regression passed **40/40**, including the enabled HTTP integration test. The earlier same-backend integration passed **210**, with two unavailable native tests skipped. API/consumer checks passed **77**, with one optional test skipped.
- Actual-App read-only Chromium QA: **38 checks passed**, desktop 1440×900 and mobile 390×844; English audit zero findings; no browser errors, overflow, attempted writes or external requests. Source `74c0d9d`, QA commit `3e45da5`, report in the QA clone `.runtime/actual-app-qa/run-ozI7aq/actual-app-report.json`. This used a mock API, not a wallet or physical mobile device.
- At 2026-10-13 03:21 KST, public HTTPS delivery matched the release byte-for-byte across seven routes, JS, CSS and brand favicon. Public JS `index-GvHbFZmh.js`, CSS `index-CHHCMzyO.css`. Real API probe passed with one market, 10 actions, five profiles, 14 curve points and 71 attention points; findings zero. Recreated sampler reused its database and skipped the already stored bucket.
- Readback reports are in `.runtime/consumer-integration/public-api-report.json` and `public-web-report.json`; server copies are `/srv/example-app/builds/consumer-public-{api,web}-report.json`.

## Boundaries and next checks

Public delivery and real API data were checked by HTTP; the connected computer-use provider had no browser available for an additional public-site interactive pass. The actual App was exercised in Chromium with the local read-only API harness. Earlier real PC/Android/Seeker wallet results remain evidence for the earlier UI, not a new-device pass for this release. New-UI wallet approval/rejection/recovery and an authenticated note write from the owning real wallet remain the next device QA. Additional proof/keeper/ops worker changes are separate integration work and were not activated here. Live remains one approved `solana` keyword; 15 multi-category markets are explicitly simulated Demo data.
