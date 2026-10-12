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

## Authorized publication and deployment — October 13, 2026 KST

The user subsequently authorized push and live deployment. Release `6b7c9d1` was pushed to `unknown2733/ante-up-app` main and deployed as image `ante-up:consumer-r2-6b7c9d1` (SHA-256 `2a46aef04b6af7defe7eb3e274c98d0229abdae6fc2acbf19dc685e3a5983361`). This supersedes the no-deployment status of the earlier integration pass above.

- Pre-push review covered 21 new commits and 92 changed historical file versions: no detected secrets or private operational endpoints. This is a scoped scan, not a comprehensive security audit.
- The Linux image used the existing base's matching lockfiles and production settings: `/api`, fixture transport disabled, Devnet, public RPC, and the production MWA app URI. Build passed; Vite reported its existing large-chunk warning.
- Linux regression: **44/44 web tests**, including the actual HTTP adapter test, and **25/25 Docs/chart/sample/social/audit tests**. The first disposable test run stopped on build-output permissions; rerunning only the test container as root passed. The deployed web continues to run as the unprivileged node user.
- Only the web container was replaced. API, price history, collector, indexer and evidence container identities were unchanged. No database migration, new data collection, program deployment or wallet transaction was performed.
- At `2026-10-12T21:46Z`, public HTTPS returned matching release HTML on 11 routes, including Docs and real/sample market details. JS `index-CqWaYqgx.js`, CSS `index-BkSLOa5l.css` and the brand favicon matched the image byte-for-byte.
- Public API verification passed with zero findings: one observed market, 10 chip actions, five profiles, 55 curve points and 112 attention points at that observation. Unauthenticated note writes were rejected.
- Local release receipts are under `.runtime/release-6b7c9d1/`. Browser rendering evidence remains the earlier local App passes. No public browser provider was available for an additional interactive pass; HTTP delivery is not a claim of public browser or physical-wallet QA.

The operational Compose stack now appends `compose.consumer-r2.yml`, selecting the new image for web only. Future service recreation must include that overlay. To roll back this earlier release, omit this final overlay and recreate only `web` with `--no-deps`, preserving the existing environment files and other overlays. The prior `ante-up:consumer-20261013` image remains available. Do not restore old databases over new records.

## Real public data correction — October 13, 2026 KST

The user's correction required removing fictitious histories and identities from the public experience. Product commit `0b5d79b` and release `e910fad` implement that correction. Earlier sample-catalog descriptions above are historical, not the current production data model.

- Production App imports the public reference adapter, not the synthetic catalog or actors. Legacy demo market/profile/record routes do not expose fixtures. Fixtures remain test-only.
- Fifteen actual subjects use verified official NASA, artist Bandcamp, YouTube or GitHub source links and images. Six have 45 daily Wikimedia observations each, August 28–October 11 UTC: 270 observations with preserved raw responses, source URLs and SHA-256 checksums. Nine have metadata only and no invented chart. Album article views are not playback counts. These are captured public measurements, not continuously collected new feeds.
- Leaderboard contains the four real ranked Devnet wallets returned by the API, with matching profile records. Unknown wallet identities use address-based geometric identicons, never fictitious people or borrowed portraits. No reference subject receives invented chip events, notes or returns. The real Solana market uses its official logo.
- Linux production build passed. Web tests: **49/49** including HTTP; source integrity, chart, social and Docs tests: **18/18**. A Vite dependency-scan teardown warning remained non-fatal. A first archive integrity test correctly failed because Windows Git archive converted the raw response's newline; `.gitattributes` now preserves exact raw bytes. All six archived responses match their source bytes and recorded hashes.
- Isolated read-only browser QA: **66 views, zero failures/errors/blocked requests**, desktop 1440 and mobile 390/320. Verified all reference images, six measured charts, nine metadata-only states, real rankings and profiles, and absent reference trading controls. Evidence: `.runtime/real-catalog-qa/browser-cKv5ns/report.json`. Root inspected desktop leaderboard and mobile chart captures. No new wallet approvals or transactions were executed.
- Scoped pre-push review found no credentials or private operational endpoints in the correction. Release was pushed to public main.
- Web image `ante-up:consumer-real-e910fad`, SHA-256 `842c30f90df70292c76b764ad19847ff9700eaca6c692fc90c9ec64e0549cfac`, replaced web only. API, collector, indexer, evidence and price-history container IDs remained unchanged. Runtime user is node (1000:1000).
- At `2026-10-12T22:07Z`, public HTTPS verified 11 routes plus matching JS `index-DlNoocb8.js`, CSS `index-ll9K8hHv.css` and favicon. API verification had zero findings: one observed market, 10 chip actions, five profiles, 59 curve points and 116 attention points. Unauthorized note writes were rejected.

The same final Compose overlay now selects `ante-up:consumer-real-e910fad`. Rollback this correction by selecting `ante-up:consumer-r2-6b7c9d1` in that overlay and recreating only web. Keep all other overlays, environment files and current data. Remaining work is physical-wallet regression and additional genuine feeds; this release does not claim video/music playback data or newly provisioned financial markets.

## Native platform counts — October 13, 2026 KST

The user requested the actual video's views, meme post's likes and song's streams rather than Wikipedia proxies, permitting static captures before automatic feed integration. Release `0d6967a` replaces production references with three YouTube videos, three X posts and three Spotify tracks. Original thumbnails, attached post images and track covers are linked. The earlier Wikipedia catalog and original evidence remain historical and are no longer imported by the production adapter.

YouTube counts come from the exact watch page's `videoDetails.viewCount`; X likes come from the exact post's public embed `favorite_count`. Spotify identity/artwork is verified against the exact official track, and cumulative streams are explicitly attributed to dated Kworb reports (September 25, October 2 and October 9). Capture time and report date are separate; no exact timezone is invented for date-only reports. [Count/source table and evidence rules](../../contracts/reference/README.md).

A single observation renders as a metric snapshot with unit, timestamp, report context and source link. It has no inferred growth, line chart, chip records or executable quote. A Post filter was added. Existing real wallet ranking/profile logic is unchanged. Minimal count-bearing source extracts and hashes are published; full original responses are retained locally without exposing large anonymous page payloads.

- Linux build succeeded; **50/50 web tests** including single-snapshot SSR and HTTP, **18/18 source/chart/social/Docs tests**. Existing Vite bundle-size and test teardown warnings remain non-blocking.
- Browser QA used the final compiled assets with read-only public API data: **51 desktop/mobile views, zero failures**, nine platform snapshots, 27 loaded detail images, three Post filter checks, and actual wallet rankings/profiles. Evidence: `.runtime/real-catalog-qa/browser-FDq5Ph/report.json`; marker `platform-native-working`, assets `index-ChsPMbkY.js` / `index-D6M8tDPH.css`. Root visually checked the mobile Spotify snapshot.
- Scoped public review of 31 files and 584 added lines found no credentials or private operational details. The public X embed token parameter is not a bearer credential. All nine exact item/count mappings and extract hashes match.
- Public main was pushed, and web-only image `ante-up:platform-metrics-0d6967a` was deployed (SHA-256 `a57e5a23b1555958d9503a635f9419748238a92a2aef3657bdca17728af35c0d`). Existing API, collector, indexer, evidence and price-history services are preserved. The final `compose.consumer-r2.yml` overlay now selects this image; rollback selects `ante-up:consumer-real-e910fad` and recreates only web.
- At `2026-10-12T22:18Z`, public HTTPS verified 11 routes and matching JS/CSS/favicon bytes. Actual API checks returned zero findings, 10 chip actions, five profiles, 61 curve points and 118 attention points. Unauthorized note writes were rejected.

No automatic platform data refresh, new market, oracle publishing, paid collection or wallet transaction was added. Further captures and physical-wallet regression remain separate work.

## Verified historical activity — October 13, 2026 KST

The user authorized connecting the researched historical observations and adding videos/tracks with daily history. Product release `ac78186` was pushed to public main and deployed. The catalog now contains twelve actual subjects; five have 61 observed history points:

- Bonobo, Rosewood: three dated cumulative stream totals, June 28–October 2.
- Khruangbin, May Ninth: three dated cumulative stream totals, February 27–October 9.
- Rumi - Topic, Free: twelve daily YouTube view counts, September 30–October 11.
- officialpsy, GANGNAM STYLE: twelve daily YouTube view counts, September 28–October 9.
- The Weeknd, Blinding Lights: 31 daily Spotify Global chart stream counts, September 11–October 11.

These are captured third-party Kworb reports. Spotify chart streams are not the all-stream cumulative counter. Official subject identities and artwork are verified separately. Date-only reports do not imply an exact observation time or timezone. Period controls end at the latest available reported date. Sparse totals render as separate points, without fabricated interpolation; missing dates are not zeros. Expandable tables expose each date, value and source. Seven other references retain their verified single snapshots. Reference action panels remain visible with execution disabled until an actual market is connected.

Five minimal source extracts retain response/extract hashes and source URLs. Full responses remain in local research evidence. Raw byte preservation, exact values and subject IDs pass the source tests. No fictional price returns, chip events, counterparties or liquidity were introduced.

- Linux production image: **51 web tests passed**, one pre-existing independent HTTP test skipped; **15 source/adapter/chart-model/Docs tests passed**. Existing bundle-size warning remains non-blocking.
- Final compiled browser QA: **105 views** at 1440/390/320, zero failures, browser errors or blocked requests. All 459 rendered observation rows matched the DTO, all 36 detail images loaded, and periods, sparse gaps, units, disabled reference actions and real API profiles passed. Six additional mobile visual views passed. Evidence: `.runtime/real-catalog-qa/browser-jK5eI4/report.json` and `.runtime/history-visual-qa/browser-HdLpnS/report.json`. A first run's mobile caption assertions were corrected to check the chart accessible unit and visible table unit; product assets did not change.
- Web-only image `ante-up:historical-activity-ac78186`, SHA-256 `b437f45e105e166e14f50bd254e4bd6afd218aa4a83dbf9ab2b362c9b036a677`, runs as 1000:1000 and passes service health. API, collector, indexer, evidence and price-history service images remain unchanged.
- At `2026-10-12T22:42:39Z` (October 13, 07:42 KST), public HTTPS verified 11 routes and exact JS `index-CMDvWtod.js`, CSS `index-epywGWZM.css` and favicon bytes. This is delivery verification, not a new physical-wallet test.

The final Compose overlay selects the new image. Rollback selects `ante-up:reference-actions-a2e5740` and recreates web only with the other overlays and current data preserved. Automatic updates, more historical sources and physical-wallet regression remain separate work; no additional API collection or wallet transaction was run in this release.

## Explore and trading chart visibility — October 13, 2026 KST

The user reported charts were not apparent on Explore and trading screens. `1469d08` adds source-backed Explore sparklines (reference ALL history, Devnet 1W history), prioritizes observed markets and daily histories, and shows metric, dates and first-to-last change. Single observations explicitly have no trend. Detail charts now lead with latest value and observed change, followed by the plot before explanatory text. Empty default price series fall back to an available observed series. Source gaps, units, execution restrictions and wallet flows remain intact.

Linux build and **52 web tests plus 15 source/chart/Docs tests** passed, with one existing independent HTTP test skipped. Full browser regression covered 141 views and found six compact-mobile visibility failures plus four QA comparisons against an older live response. `e77f0de` compresses headers at short viewport heights, and the runner now compares against the actual browser-served API response. The final exact Linux bundle passed **21 focused views** across 1440/390/320, including Explore and daily/sparse/live Buy/Sell, Pro and LP routes. Root/QA inspected screenshots; the 320px plots start above fixed navigation. No wallet transactions were run. Evidence: `.runtime/real-catalog-qa/browser-3PZeFA/report.json` (initial findings) and `browser-lG7eZD/report.json` (resolved checks).

Public main was pushed. At `2026-10-12T22:53:28Z`, web-only image `ante-up:trend-visibility-e77f0de` (SHA-256 `c1aa61adf4447289e0facbad4da7bd7f6257e6429910e9a043071c42ca010638`) was running as 1000:1000 and passed health. Public HTTPS verified 11 routes and exact `index-TgAVkDNS.js`, `index-DgVQkO1D.css` and favicon bytes. Rollback selects `ante-up:historical-activity-ac78186` in the final web overlay and recreates web only. Captured reference activity remains separate from token price, automatic collection and actual trading availability.
## Illustrative trends for limited histories — October 13, 2026 KST

The user explicitly requested temporary values where observations are insufficient. Releases `1ac9208` and `75772aa` add a separate illustrative series to nine reference subjects with fewer than four actual observations. Each contains 29 stable daily preview points across 28 days, normalized to latest = 100. Three existing daily histories remain measured-only. Original counts, source extracts, hashes and actual history series are unchanged.

Explore and detail default to the supplemental trend where present, visibly labeled **Illustrative trend** and **not measured**. **Measured data** switches to the original observations and source table. Generated points have no observation IDs or source URLs and are not published to the oracle, SAS, trading, rankings or settlement. Reference actions remain disabled until a real market is connected. README and product Docs explain this display-only exception to the earlier measured-only presentation.

Linux checks passed: 53 web tests (one existing independent HTTP skip), 19 source/helper/chart/Docs tests, chain/API type checks and production build. Browser regression covered 75 views at 1440/390/320 with zero failures, all 36 artwork checks, actual-data toggles and preview period selection. Short mobile layout was then compacted; the final exact Linux bundle passed 12 focused views, including five subjects at 320px and a 390px smoke. Visible plots at 320px increased to 73–96px above navigation. Reports: `.runtime/real-catalog-qa/browser-hkO9FP/report.json` and `browser-PIlCBi/report.json`. No wallet transactions were run.

Public main was pushed. At `2026-10-12T23:24:45Z`, web-only image `ante-up:illustrative-75772aa` (SHA-256 `6bc7ff3d4b70086d688ac78a7932aad2922f3c34b7e1fe4ef2b41b910263dbb3`) passed health as user 1000:1000. Public HTTPS matched 11 routes, JS `index-D6oZbacJ.js`, CSS `index-D4YxONXM.css` and favicon byte-for-byte. Rollback selects `ante-up:trend-visibility-e77f0de` in the final web overlay and recreates web only, preserving current data and other services. Actual feed expansion remains separate work.


## Shareable chip result cards — October 13, 2026 KST

The user requested shareable result cards. Product commits `687b6c9` and `4bc943b` add **Create result card** to finalized, closed chip records. The brand-styled 1080×1080 PNG includes subject, exact rational attention change rounded to two decimals, wallet, UTC entry/exit times, Devnet label, public record address, proof status and capture time. N/A remains N/A. Open or unfinalized records cannot create a completed card. Temporary reference chart data never enter this path.

Users can preview, save PNG, copy the record URL, or invoke native file sharing when supported. No signature or automatic social posting occurs. Unsupported/failed sharing retains download and link controls; cancellation is quiet. Source text is SVG-escaped, the logo is embedded from the local brand asset, and the renderer needs no external screenshot service. Matching proof/record IDs are required for the proof badge; pending, invalid, replaced and unavailable states remain distinct. Local samples have no public record URL.

Initial browser QA found a title-loading race and small-screen overflow. The final version waits for market/proof reads, freezes one snapshot per user request, wraps record IDs and bounds the dialog. Linux chain/API checks and production build passed; 57 web tests passed with one existing independent HTTP test skipped, plus the Docs link check. The first attempt to run the test prebuild as the immutable runtime user failed on write permissions; the test suite passed in a separate disposable test container. Production remains user 1000:1000.

Final exact-bundle browser QA passed 12 cases across 1440/390/320, with zero failures/errors/blocked requests. Nine PNG exports verified 1080×1080; mocked native sharing received the exact downloaded PNG SHA-256 and canonical link. Real positive/negative public records were used; OPEN/N/A cases were explicit local response overrides. Title, copy, cancellation, failure fallback and mobile layout passed. Root and QA inspected images. Evidence: `.runtime/result-card-qa/browser-0ssQis/report.json`; runner `scripts/result-card-browser.mjs`. Physical OS sharing is not yet tested; no wallet transaction or social post was made.

At `2026-10-12T23:33:35Z`, public main was pushed and web-only image `ante-up:result-card-4bc943b` (SHA-256 `8ae8ebe4af6a525ce4efcb2769e5689cef9f42a8793ca44944bd14aff55abc6e`) passed health. Public HTTPS matched 11 routes plus JS `index--iu86NFE.js`, CSS `index-DLUhf4qx.css` and favicon bytes. Rollback selects `ante-up:illustrative-75772aa` in the final web overlay and recreates only web, preserving other services and data.
