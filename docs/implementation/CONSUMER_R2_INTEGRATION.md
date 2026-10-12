# Unified consumer R2 integration — 2026-10-13

## Scope and source

Integrated in `consumer/unified-integration`, starting from public snapshot `e5a8b70` and shared contract `9da25f7`. This report describes local integration; it does not claim a public push, production deployment or a new physical-wallet test.

The product-source checkpoint is `2fd5de0` (Docs recovery-link touch target), following `6055e17` (source-badge copy) and `c771690` (Docs navigation touch targets and media layout). QA-only scripts and this report may have later commits.

## Included changes

- One Explore catalog, with the existing observed Devnet market and 15 recognizable sample subjects; no global Live/Demo switch. Sample histories retain source labels and cannot open financial or chip transactions.
- Official subject links, credited cover/thumbnail sources and deterministic fictional-profile avatars. Recognizable artwork does not imply a live source feed or real person's trading history.
- Chart placement events no longer infer that a chip is still active. Profile activity uses placement/close events, preserves note timing and links back to the selected chart action.
- `Free Call` customer-facing copy replaced with chip language. The approved slogan and internal identifiers remain intact. Technical evidence is available through disclosure sections.
- Ten product articles are rendered at `/docs` and `/docs/:slug`. Unknown article routes show a not-found page. Invalid percent-encoded HTTP paths are rejected with 400 by the web server; client route decoding also fails safely. Desktop and mobile navigation include Docs.
- App passes market media and shared avatar/subject renderers into profiles and leaderboards. Failed image URLs can recover when the source changes. Shared image placeholders fill their containers and use the product palette.
- Mobile Docs navigation targets are at least 44px; paragraph text links retain normal text layout.

## Integration fixes

| Finding | Resolution |
| --- | --- |
| Closed chip's old placement event labeled Active | Event semantics in chart and social components; regression tests |
| Generated avatar rejected by social URL filter | Shared deterministic avatar renderer; arbitrary supplied data URLs remain rejected |
| Profile subject covers missing | App maps catalog metadata into `marketMedia` and injects `SubjectImage` |
| Docs navigation led to placeholder | App imports and routes the real Docs module |
| Notes still described the old fictional subjects | All 15 scenarios' notes revised and outcome consistency tested |
| Broken image hid a newly changed URL | Failure state tracks the failed URL |
| Oversized NASA images and mismatched placeholder palette | 720px source derivatives and branded fallback |
| Mobile Docs navigation too small | Dedicated Docs CSS correction after rendered QA |

## Automated verification

- Web regression suite: **43 passed, 1 existing HTTP-integration skip, 0 failed**. Includes wallet cancellation/UNKNOWN recovery, transaction verification, finalized barriers and chip limits.
- Sample read adapter: **9 passed** across real-subject mappings, note outcomes, media safety, period consistency, profiles and ranking rules.
- Chart model: **6 passed** across filtering, gap handling, markers, event labels and image recovery.
- Social SSR: **5 passed** across historical placement status, live copy, notes and avatar/media rendering. Vite emitted a dependency-scan teardown warning; assertions passed.
- Docs local links: **1 passed**.
- R2 audit regression tests: **4 passed**.
- Production web-server SPA/proxy/error regression: **1 passed** (loopback-capable execution environment).
- TypeScript and Vite production build passed, including the `/api` configuration. The wallet-enabled bundle has a non-blocking Vite size warning.
- Public read-only GET of `https://ante-up.fun/api/v1/consumer/markets`: HTTP 200, Devnet envelope and the existing `solana` market `7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT`. The current merge function produced 16 unique catalog entries with 15 samples. This checks API compatibility, not new on-chain execution.

## Browser evidence

Browser QA uses a read-only local mock API; its Live row has no observations or transactions and is not evidence of real Devnet activity. Public API compatibility is the separate check above.

Evidence directories are under the sibling QA checkout, `../ante-up-r2-qa/.runtime/consumer-r2-qa/` (ignored local artifacts).

| Pass | Evidence | Result |
| --- | --- | --- |
| Full App routing and responsive layout at `c771690` | `browser-C6UuSC/report.json` | 91 captures, 0 failures; desktop 1440px and mobile 390/320px; 15 sample details, Docs home and ten articles; no horizontal overflow or sample execution controls |
| Click journeys | Included in the full pass, first checked in `browser-PGjsOn` | Mobile chart marker → selected profile note → chart; Docs tab → article → internal link; desktop Docs table of contents |
| Public cover images at `6055e17` | `browser-UIYUVF/report.json` | All 15 sample detail covers have `complete=true` and positive natural width; 16 captured views, 0 failures |
| Explore image completion | `browser-amvR4L/report.json` | All 15 public cover images loaded; bounded wait up to 12 seconds; 0 failures |
| Latest targeted regression at `2fd5de0` | `browser-QoKGQn/report.json` | 28 views, 0 failures; updated source badge, unknown Docs recovery link, client-side malformed slug, Docs and chart/profile journeys |

Root inspected mobile chart, profile and Docs screenshots as well as the JSON results. The initial loopback connection failure captures were discarded. External image denial in the fallback-only pass is intentional and counted separately from unexpected application errors. Public image checks allow only the catalog's HTTPS image origins and read requests; application writes and external RPC remain blocked.

The structured R2 auditor separately reported **13 PASS, 9 PENDING, 0 FAIL** with the local read-model export. Its pending evidence fields were not backfilled with invented approval flags; browser evidence remains in the reports above. This is not an all-gates release certification. Physical wallets, actual execution/finality and deployed-environment regression remain separate acceptance work.

## Release boundaries

- No public push or live deployment performed in this integration pass.
- Desktop Phantom, Android Phantom and Seeker require a regression pass on the new deployed UI. Earlier successful wallet runs do not certify this build.
- Archive/SAS worker follow-ups, keeper/settlement and operations work from separate branches are outside this UI integration.
- Sample targets have no newly provisioned feeds, markets or user assets. No paid source collection was added.
