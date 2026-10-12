# Consumer completion — parallel contract, 2026-10-13

User approved eight NEW sessions and parallel implementation. Baseline before this contract: bcc8e4284941308482c86036ad4f90c16e890c1a. This document supplements A_CONTRACT.md and MVP_SPEC.md; it changes no financial rights, rates, receipt verification, or on-chain state. Shared consumer DTOs are in contracts/consumer.ts.

## Integration and ownership

Each session uses its own local clone under .codex-work/implementation/ante-up-consumer-<role>. Never edit the integrated repository or another session's clone. Commit only owned changes and finish HANDOFF-<role>.md with commit IDs, verification, integration entry points and limitations. Do not push or deploy. The coordinating session alone changes the server, shared contracts, app routes and vault HOME. Read vault sources as needed; do not write them from worker sessions. This overrides the old projectless-directory sentence in AGENTS.md for this phase.

| Role | Owned implementation | Delivery |
|---|---|---|
| ui | apps/web/src/consumer-ui/, apps/web/src/styles.css, apps/web/index.html, apps/web/public/brand/, favicon assets | Brand tokens, shell, discovery, reusable controls, English copy and route-composition guide |
| charts | apps/web/src/charts/, services/api/src/consumer-history.ts, services/api/test/consumer-history* | Accessible chart/markers + read-only history adapter, precise app/API registration instructions |
| presets | apps/web/src/demo/, contracts/fixtures/consumer/ | Deterministic multieweek markets, charts, actors, notes and separate demo read adapter |
| social | apps/web/src/social/, services/api/src/consumer-social.ts, services/api/test/consumer-social* | Free public leaderboard/profile/activity/notes, authenticated note storage adapter and integration guide |
| proof | services/evidence/, proof-specific scripts/tests, HANDOFF-proof.md | Retry/response/idempotency fixes and safe deployment/verification recipe |
| keeper | services/keeper/, services/api/src/keeper-*.ts, keeper-specific tests, deploy/compose.keeper.yml | Always-on bounded keeper, maturity/LP window recovery and tests |
| ops | scripts/ops/, deploy/ops/, services/api/src/visitor-faucet.ts, related new tests | Bounded public demo readiness, visitor SOL path, backups/recovery/health tooling |
| qa | apps/web/qa/consumer/, tests/consumer/, docs/qa/consumer/ | Independent regression harness, English and responsive audit, final QA matrix |

Root owns App.tsx, Financial.tsx, wallet/execution controllers, existing api.ts/model.ts, services/api/src/app.ts/server.ts/live*.ts, contracts except the assigned consumer fixture directory, shared manifests/locks and deployment. Workers may propose small integration patches in their HANDOFF; do not block their independent modules on app wiring. If a dependency is required, document exact package/version and patch rather than competing on manifests. Use existing libraries when practical.

## Shared semantics

- LIVE means actual Devnet observations/records; DEMO means explicitly synthetic scenarios. Separate namespaces, identities, balances, ranking and execution. No generated live history. REPLAY requires a real cited source and is not needed in this slice.
- Epoch millisecond timestamps in consumer DTOs; opaque string IDs; decimal strings for prices/amounts; return fraction 0.10 = +10%. Missing values use null, never fabricated zero. Conversion to display numbers is not financial arithmetic.
- Series kinds: curve spot quote, index reference, executed trade and attention index. Never silently mix kinds or connect across missing history. A free call is not a fill. Marker value is optional when contemporaneous value is unavailable; never substitute today's price.
- Curves and reference series label their kind. Execution price/fees stay in existing receipt/quote UI. Chart is informational and cannot bypass quote, expiry, signature or finality checks.
- Public live social scope: free calls including ongoing calls. Pro/LP and other wallets' paid activity remain outside this public feed. Own financial history can be shown locally. DEMO may illustrate future social coverage with synthetic actors.
- Notes: optional plain text, maximum 280 Unicode code points. Server timestamp and authenticated wallet ownership; action must belong to that wallet. An after-the-fact note is labeled added later. Edits keep history and label edited. Notes are not included in existing SAS proof claims; no backdating or HTML rendering.
- Leaderboard: preserve valid closed free-call arithmetic mean, recent 7 days/all time, count and N/A handling. Money PnL does not enter this rank. DEMO rankings separate.
- Consumer defaults: English, browser lang=en, concise natural labels. Prefer Make a call / Close call for free actions, Buy / Sell for token trades, Pro, Liquidity, Proof, Live Devnet, Demo. Reconcile with docs/GLOSSARY.md; SAS details belong in proof detail, not primary action copy.
- Brand: official speech-bubble chip symbol and ANTE UP wordmark/orange period; warm offwhite, black typography, blue navigation/connection, orange participation. UI owner supplies CSS custom properties; other modules scope styles under their component class and use --au-* with conservative fallbacks. Avoid generic repeated cards and oversized marketing headlines in trading flows.

## Integration interface

Consumers use ConsumerReadApi in contracts/consumer.ts; existing MarketApi and transaction interfaces are untouched. Root adds composition and route wiring. Chart component should accept a MarketHistory plus onSelectAction callback; social components accept public profile/leaderboard DTOs and navigation callbacks. Demo provider supplies the same consumer read interface. Workers export named components/functions and list props/imports in HANDOFF.

The root will wire the live read adapters to existing finalized observations/receipts. If some fields have no evidence, return missing/empty history honestly. Notes module should expose an authenticated service with injected persistence/clock and produce storage migration proposal; root wires it to existing auth/store. Authentication must not add a wallet prompt to public reads.

## Operational snapshot and constraints

https://ante-up.fun is live Devnet on deployment-host. Existing wallet signature protections, UNKNOWN recovery and fee accounting have passed actual Seeker buy/sell and three free-call device paths. Preserve them. DEVICE_WALLET_VALIDATION.md and HANDOFF-financial-qa.md are current evidence; old generic docs may say unimplemented.

Actual X collection is solana only, five-minute polling; do not expand paid calls or auto-create on-chain markets for presets. Synthetic finance QA has 35 finalized transactions but actual weekly maturity/always-on keeper remains unverified. No worker changes admission, faucets, upload allowlists, budget caps or live balances.

Proof snapshot: one earlier issued SAS; four later records uploaded, with Accepted-as-JSON/timeout and confirmation issues. Inspect code and saved evidence first. Do not reset receipts/budget ledger, re-upload by default, weaken 20 confirmations or start a second uploader.

Ops and keeper scripts default to dry-run/bounded behavior. Prepare deployment recipes; root executes state-changing server operations. Do not read or print secret files. Read-only server metadata checks may be proposed to root. QA may inspect public web but USB/ADB belongs to one assigned session only after coordination; never approve wallet requests or claim fixture tests are device tests.

## Delivery and final QA

### App/API integration delegation — 2026-10-13

User authorized App/API composition, deployment-host price-history activation and integration validation. Baseline `248367f` combines the five consumer branches. UI now owns App/api.ts/consumer HTTP wiring and web tests in its own clone; social owns API app.ts/live.ts/server.ts composition and API tests. Root alone owns deploy configuration, shared contracts, server changes and final merge. QA owns actual-App browser checks, without wallet approvals or financial writes.

Live read routes are `/v1/consumer/markets`, `/markets/:id/history?period=1D|1W|1M|ALL`, `/profiles/:wallet`, and `/leaderboard?period=7D|ALL` under that consumer prefix. All return existing v0.1 envelopes with `mode=devnet`, seconds `asOf`, data and nextCursor. GET/PUT `/v1/consumer/notes/:actionId` also return envelopes: GET data is `{note,revisions}`, PUT data is `{note}`. PUT body is `{wallet,body,expectedVersion}` and requires the existing authenticated bearer session. DTO timestamps remain milliseconds. There is no Demo-to-Live fallback or Demo signing.

The optional `ANTE_UP_PRICE_DB` config points to a dedicated history database. Absence preserves honest empty/sparse history and must not prevent API startup. Root initializes this DB with a one-shot before activation and verifies real finalized reads. Existing paid collection, admission and budgets are unchanged.

### Pre-integration corrections approved 2026-10-13

Canonical live action IDs are `devnet:<programId>:<recordId>:open|close`, produced and parsed only through `contracts/consumer-identity.ts`. Charts and social must use the same namespace, including note lookups and profile-to-chart selection. No live records/notes use the legacy `free:` prefix. No migration is needed for new consumer notes because these modules have never been deployed. Demo identifiers retain their isolated `demo:` namespace.

The UI session now additionally owns English-only edits in App.tsx, Financial.tsx, walletSdk.tsx and user-facing walletErrors.ts copy on its own clone. Preserve execution logic, IDs, error codes, signatures, amounts and expiry handling. Root will not edit those files until the copy commit is delivered. Chart owner may add a dedicated bounded finalized-price sampler, its tests and a separate compose file; no live server changes. QA may create an ignored integration preview inside its own clone to combine committed modules for cross-module and browser verification; this is not a production merge or deployment.

Proceed with independent modules immediately. Use targeted meaningful checks. HANDOFF must include: commits; files/exports; concrete integration instructions; real test outcomes; unresolved dependencies; exact deployment/recovery steps where relevant. No remote push. The user authorized the coordinator to read progress and send follow-up instructions. Workers do not need to message other sessions.

Final integrated PC/Android Phantom/Seeker QA happens after UI, chart, presets, social and English integration. QA session starts harness/checklist now and marks absent implementation as pending rather than passed. Root reviews and integrates each completed slice as it arrives.
