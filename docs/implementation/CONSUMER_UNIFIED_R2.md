# Unified consumer experience — implementation contract

User-authorized scope, 2026-10-13. This supersedes the old separate Live/Demo navigation requirement, not provenance, authorization or financial semantics. Parent baseline: public snapshot e5a8b70. Each assigned thread works in its own r2 clone; no remote push or server changes from worker threads. Integration owner assembles and deploys verified work.

## Product contract

- One Explore catalog containing the existing real Devnet market and all 15 existing sample scenarios replaced with identifiable real subjects. Keep stable scenario IDs where possible; real subject titles, official links, creator names and appropriate real artwork. Show Sample history locally for synthetic charts and Example profile/activity for fictional actors. Never claim fabricated trades or statements belong to real artists or users. A real subject does not imply a live data feed or executable market.
- Remove global Live/Demo navigation and mode query from the normal journey. Old links still resolve. Retain internal source.mode and namespaces to distinguish evidence, route lookups and execution. No synthetic entry into real rankings, wallet prepare, SAS or settlement. A UI-only catalog item cannot acquire execution permissions from a pretty title or image.
- Existing solana market ID, note ownership/version checks, free participation limits, source timestamps, errors/recovery, trade quotes and accounting stay intact. No new paid provider calls or onchain registrations.
- Public language is English. Free Call is an internal name, never a customer feature name. Keep existing API/chain CALL_* types and technical historical documentation. Public controls: Chips (participation tab), Place chip (open), Take back chip (close), Active chips, Chip history, Leaderboard, View profile, Verify record. Activity: Placed a chip / Took back a chip. Subtitle for close: Finalize your result and free up this chip. Explain no-money participation in short conditions, not a Free Call title. These are implementation copy decisions under the user's chip direction, not a claim the user selected each English string.
- Keep the approved slogan Call it. Ante up. Prove it. Buy/Sell, Pro Long/Short, liquidity deposit/withdraw retain their accurate financial names. Do not call a free close Cash out or Fold; do not imply guaranteed protection/returns. Attention change is not monetary P&L.
- Official speech-bubble chip logo; warm off-white, dark type, orange chip/action accents, blue search/connect. Avoid repeating decorative cards and large technical warning paragraphs. Technical provenance belongs in accessible details. Chip count and placed/returned chip state should be visible in the core experience.

## Ownership

| Role | Owned files | Outside scope |
|---|---|---|
| ui | apps/web/src/App.tsx, consumer-ui/**, styles.css; public copy in Financial.tsx, fixture.ts, walletErrors.ts, liveFree.ts, liveFinancial.ts, transactionBoundary.ts, http.ts; root UI tests as necessary | No contract/API/finance behavior changes; do not edit social/charts/demo/docs modules |
| presets | contracts/fixtures/consumer/**, apps/web/src/demo/**, apps/web/public/media/**, new apps/web/src/media/**, media provenance docs/tests | No App, common CSS, shared contract edits |
| social | apps/web/src/social/** and module tests | No App or common copy file edits |
| charts | apps/web/src/charts/** and module tests | No collector/server/API changes in this round |
| docs | docs/product/**, apps/web/src/docs/**, README.md | No App/nav/package changes: hand off exact wiring and dependencies to ui/root |
| qa | independent R2 audit scripts/tests under scripts/consumer-r2-* and own runtime outputs | No product source changes; report defects to integration owner |
| integration owner | contracts/consumer.ts, API and cross-module wiring, merging, release, vault records | Workers never edit HOME or project decisions |

## Media/interface agreement

contracts/consumer.ts adds optional subjectUrl, creatorLabel, imageAlt, imageSourceUrl to ConsumerMarket; avatarUrl/avatarAlt to ConsumerProfile, actorAvatarUrl to ConsumerAction. Existing thumbnailUrl continues to hold market artwork. Older API responses remain valid. No API decoder shall demand these fields.

Presets own apps/web/src/media/SubjectImage.tsx exporting SubjectImage({src?: string, alt: string, className?: string}) and WalletAvatar({address: string, src?: string, className?: string}), using safe image failure fallback and stable generated wallet identity fallback. No arbitrary real-person photos for fictional profiles. Presets document real-media source/attribution and fallback. UI/social/charts may initially use local img/fallback then consume these exports during integration. Preserve current consumerDemoApi exports for compatibility; public component language becomes sample/preview instead of a separate Demo mode.

UI owns data routing: unify listMarkets with deterministic ID de-duplication; resolve history/profile from the correct backend by stable ID, not user-controlled mode alone; preserve real ranking integrity while allowing sample profile exploration. Do not change actual API state to pretend all sample subjects are live pools. Real API unavailability must remain visible rather than silently substituting a sample record.

Social retains component exports/props, may add optional market metadata map and avatar props. Missing additions must fall back to readable titles/stable icons. Activity rows: avatar, actor, subject art/title, action/time, result, one or two note lines, drill-down to chart and proof; group dates; touch targets, pending/N/A and negative outcomes first-class. Research official/public Fomo and Toss Securities surfaces before borrowing interaction patterns; record sources and access limits.

Docs exports DocsPage({slug?: string}) from apps/web/src/docs/index.tsx, owns its local stylesheet. Pages live at /docs and /docs/:slug; root/ui owns route and desktop/mobile nav integration. Prefer Markdown source with a safe renderer or existing toolchain; no unsanitized HTML. Topics: start, chips, markets/trading, Pro, liquidity, data/pricing, records/proofs, Devnet support/FAQ. Verify statements against current code/config; mainnet, real return guarantees and future features are not implemented claims.

## Delivery and verification

Read README, CONTRACT_V02 and relevant tests. Check branch/status first. Commit only assigned files with configured public noreply author. Never merge old private development history into these branches. Preserve other workers' files. Record commit hashes, exact tests, limitations and wiring in a role-specific HANDOFF-R2 file; do not put personal server paths, credentials or fabricated validation in public docs. Root decides whether handoffs enter the public tree.

QA can prepare checks and inspect baseline in parallel; final acceptance requires integrated build. Validate no global mode switch, 15 subject mappings + existing live market, working artwork/fallback, chart/action/profile consistency, no Free Call UI including accessibility/errors, Docs links/mobile access, sample execution disabled, real wallet authorization preserved. Browser mocks do not prove physical wallet QA. No live transactions or wallet signatures without root coordination.
