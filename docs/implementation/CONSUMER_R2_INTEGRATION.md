# Unified consumer R2 integration — 2026-10-13

Current deployment and device status are recorded in **Mobile signing and device QA — October 13, 2026 KST** below. Earlier sections preserve their checkpoint-specific results and limitations.

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

## Interactive trading and demo execution integration — October 13, 2026 KST

Parallel work on trading layout, runtime readiness, and result/proof UX was integrated in d7970d0 and 82340ef. Desktop keeps chart and order form side by side; mobile has a compact chart above the form. Chips default to attention, trading tabs to the appropriate price. Pointer/touch/keyboard inspection, zoom, pan, reset, gap handling and Explore hover are interactive. Missing observations and illustrative reference data remain explicit.

Finalized action receipts persist through data refresh; stale or incomplete refreshes block new actions. Chip completion links directly to records/results, proof pages expose validated Devnet, SAS and Arweave links, and closed records retain PNG sharing. Financial panels show balances, positions and receipts. Actual OS sharing and new physical-wallet transactions remain separate checks.

The operator-paused Free gate now has a distinct explanation from data failure and numeric limits. A bounded one-hour admission helper preserves existing caps. Keeper changes include bounded execution and empty-cycle recovery. The prepared synthetic financial market has explicit provenance, uses no additional X collection and cannot create Free records through the API. Graduation and its 15-minute initial LP clock are intentionally deferred until the tester is ready.

Exact Linux image ante-up:demo-experience-82340ef (SHA256 6b10fed774e19e077f5acda87652b13d712cb7db47881c4109526c96620b17c2) built successfully. Tests: 61 web passed/1 existing HTTP skip, 8 chart, 19 keeper, 11 API/history/keeper adapter, 5 financial harness. Exact-bundle browser QA: 22 trading/interaction cases and 27 result/proof cases, no failures/errors/blocked requests; 15 PNG exports validated. Reports: .runtime/trading-layout-qa/browser-XUW2v7/report.json and .runtime/result-card-qa/browser-d182ha/report.json. Assets: index-CBeu4pgo.js and index-DjPue-GC.css. Deployment and device evidence follow below.

## Mobile signing and device QA — October 13, 2026 KST

Source: project Working note `20_Working/2026-10-13 컨슈머 UX와 데모 완성 작업안.md`, section 23, plus the deployment coordinator's exact asset identifiers. This is a status reconciliation; no device or server actions were performed while updating this report.

### Confirmed Free chip flow

- Seeker + Seed Vault: entry at 09:37 KST and close at 09:43 KST completed with the user's approval and FINALIZED UI. Record: `EfCpStfVtdF1zuToUpjSuqviW5cG4VT952PiP1dAh8nY`.
- Entry signature: `2dB6JMRo2f3dzzT5sBWynv2UdTc3EneHCR4aRpn5aCdNB2Zni7UshKt7mETfcMJqDPofFx5U6odW4oCQA7kEMQqb`.
- Close signature: `1i8Bpbe6gmqtt65GozoZ6nK7XmeCrFN9n41WhRUSyCddu4yvecdksTPs2CaKNNmBVRtBRT3eFuRoFnW3jADhMh7`.
- Active slots returned from 1/3 to 0/3. The closed result generated a PNG card and enabled share/save controls. SAS for this record was still pending at the observation; card creation does not establish SAS issuance or an external social post.
- In the observed wallet flow, Native Success sometimes required tapping Close before the web response returned. The user performed biometric approval. An earlier expired blockhash attempt was confirmed unexecuted before the fresh successful request.

### Financial signing changes and remaining device blocker

Financial preparation and signing now use separate taps. Input, wallet, signer or screen changes invalidate stale prepared quotes; the review displays the actual action, direction and leverage. MWA authorization cannot reuse another chain's cached authorization. SDK overlay layering was corrected. Display copy was simplified while Devnet, source and illustrative-history qualifications remain available in details.

`0cd5dfe` fixes duplicate authentication during parallel balance/vault reads by sharing an in-progress authorization for the same wallet, signer and chain, with correct failure/change cleanup. Its focused checks passed 17 cases. This code defect was not established as the sole cause of the earlier native websocket error. A read using the existing approved session showed **999.997998 tUSD and zero LP shares**.

The first financial market's LP window had ended. A new liquidity market, `ApyEauP8KhFLxo6v1BTkJSiJogN9dKXueM715GBdyZDP`, was prepared and graduated after authentication, with its feed started and the initial LP window scheduled to end at 10:07:12 KST.

For the 10 tUSD LP request `3e65bae3-5f11-4175-9cb7-b2bd1817de6f`, the user reported a native error after approval. At 09:57 KST, the server still reported UNKNOWN with a null signature, while chain checks showed the expiry height had passed, no holding account or new transaction, **zero LP shares**, and **999.997998 tUSD unchanged**. These observations establish an expired, unexecuted attempt; they do not establish a successful deposit or a known cause of the native error. No automatic resubmission occurred. The earlier LP request `ad464214-dddf-48ae-bcd5-dfdb3d6f7aca` also expired without a signature, LP shares or balance change and was resolved through status lookup.

USB debugging disconnected while inspecting that native error. Windows reported the device present, but ADB was offline. The device connection was subsequently restored and device QA resumed. Sandbox command escalation was a separate tooling restriction, not evidence of a continuing device fault. The earlier native error's precise cause remains unconfirmed.

### Device QA after connection recovery

The coordinator verified these subsequent Seeker + Seed Vault actions on market `ApyEauP8KhFLxo6v1BTkJSiJogN9dKXueM715GBdyZDP`:

| Action | Evidence | Verified result |
| --- | --- | --- |
| Deposit 10 tUSD into LP | Signature `3BjzmBmhxFQMzhukBCDLc3qnWB7fMjvDatJcKwxGczzqkfovtqpoVG93Ve3hKjro1rzVqaCfSSEyfeXaq5Dpky9t` | FINALIZED |
| Withdraw the 10 tUSD LP deposit | Signature `4PpFmpJXBA4L4MrUNMAPM5Ut8HdmGEN25k7ci4uthzw8S9exvTN1b4bNCg8hntBjNG4GQx9T6QnXX6Z6Gggq7Gs6` | FINALIZED; LP shares returned to zero and balance to 999.997998 tUSD |
| Buy 1 spot token, then sell it | Request prefixes `31e8e3fd` and `819b21b8` | Both FINALIZED; tokens returned to zero, balance 999.995598 tUSD, 0.0024 tUSD round-trip fees |
| Open a 5× long with 10 tUSD collateral | Request prefix `86c277c3`; position `BpRPnZuXg93PLcTsy6ebzhebKszv6REJDbU7ik4RcxCe` | FINALIZED; balance 989.618377 tUSD, maximum payout reserve 160 tUSD |
| Close that Pro position | Request `6d25f8f4-0a96-4558-b76a-81f653aacff8` | Native unknown-instruction error; chain position remained OPEN and no claim was created |

Request prefixes above are abbreviated coordinator references, not complete request IDs or transaction signatures. The Pro close failure was traced to a time-accrual/refund `minReceive` race; the API fix uses the quote-deadline refund for the minimum receipt while the actual claim retains the execution-time refund. A subsequent fix seals deadlines after pricing reads. Linux regression and deployment are recorded below, but **a successful device close retry is not established by this update**. LP and spot round trips are complete; **Pro close/claim, remaining directional coverage and normal-maturity keeper validation remain open**. See `docs/qa/liquidity-demo-20261013/MOBILE_EXECUTION.md` for simulation versus signed-execution evidence. Do not report all financial QA complete.

The scheduled Free admission gate closure was verified at **10:08:55 KST**. This records closure of new admission, not deletion of existing chip records.

### 09:58 KST deployment checkpoint

- Public source: `20780b3`; web image: `ante-up:mobile-followup-20780b3`.
- Image SHA-256: `161b8119db416069cf9823d40255539a37e989510f7715a0d96557e5d5743868`.
- Live assets: `index-Bd0h9Qo_.js` and `index-3VbIcoYB.css`.
- Linux checks: **76 passed, one pre-existing independent HTTP skip**. HTTPS delivery passed. This does not substitute for financial device QA.
- The release includes the Seeker/400px Explore registration CTA overflow fix (client width 400 / scroll width 423 corrected to 400), checked at 320/400/1440 widths and through registration navigation.
- Only web was replaced; the new registry/indexer paths and other services were preserved. ADB access is restored; device QA continues with the unresolved Pro close path above.

The preceding `f4e335e` exact Linux bundle passed 26 chart/layout cases and 27 result/proof cases; the latter report is `.runtime/result-card-qa/browser-9rlfI9/report.json`. Those browser results belong to that earlier bundle, not an additional exact-bundle run of `20780b3`.

### 10:38 KST capture and quote-fix deployment

The coordinator deployed image `ante-up:capture-quote-78a1d10`, with public source checkpoint `206d58d` and tested integration source `78a1d10`. Public HTTPS verified 11 routes and exact asset delivery. Live JS is `index-CZJIxf0K.js` (SHA-256 `9ec7b02700456e976692c1046cc9f1e1dff4386a43b1a9b49143d29f022a8d0f`); CSS is `index-Dly_HIQq.css` (SHA-256 `611e7066f3daf0462a29a613dff0fa216e97c0c9c7687b9ea5ff381dc987bacd`). Linux financial tests passed 16 cases plus typechecking; web tests passed 80 with one existing skip. Exact-bundle market QA passed four views and the existing result/proof regression passed 27 cases.

The localized capture changes explain attention measurement next to the chart, remove mobile chart pinning during chip participation, and condense the record's top summary. The real `EfCpStfVtdF1zuToUpjSuqviW5cG4VT952PiP1dAh8nY` result is approximately **−0.00881226067274309%**, displayed as **−0.01%** by exact rational rounding in both its summary and existing result card. The summary shows solana, closed/finalized state, placement **00:37 UTC**, return **00:43 UTC**, **Proof pending**, and a Verify record link. Long IDs and original rational values remain in collapsed details; full evidence and sharing remain below. No proof issuance is inferred from closure or card generation.

Additional exact-bundle QA at **400×712** passed all **10 cases** with zero page overflow, browser errors or blocked requests. It exercised the actual EfCp record, issued/pending/invalid evidence paths and PNG sharing, with local response overrides only for the documented synthetic QA cases. Visual inspection confirmed every summary item above fits before bottom navigation. Report: `.runtime/result-card-qa/browser-g0rCKD/report.json`; actual-record screenshot: `.runtime/result-card-qa/browser-g0rCKD/mobile-400-closed_result-0-summary.png`. This isolated browser capture is not a Seeker screenshot or a new wallet transaction. Root continues actual Pro device retesting; no successful close/claim is claimed here.

### 10:40 KST Pro long close confirmed

The coordinator confirmed the real Seeker long close FINALIZED: request `4a75b231-2946-47df-a08d-03b3c905c12d`, signature `44vdwm48Wa833XtatiHAWJ8KvxgHiviVJabpgZaDKSYYwhW7iUbMThFTJEUxwyjFycckYU1PQ19CUDCRjfY3wudW`. Position `BpRPnZuXg93PLcTsy6ebzhebKszv6REJDbU7ik4RcxCe` became SETTLED. Claim `BJmxZLkNEJTKKsVym5X3qXQirkgDyiwwLzTMJ6Eb8kR1` was UNPAID for 10 tUSD payout + 0.326152 tUSD refund = **10.326152 tUSD**. The signed minimum was 10.326145 tUSD; actual settlement exceeded it, confirming the refund/deadline fix in a real transaction.

Pro reservations fell to zero and other reservations became 10.326152 tUSD for the unpaid claim. Wallet balance remained 989.618377 tUSD: closing created the claim, not a completed payout. At the subsequent 01:41:59 UTC claim-approval step, the user's signature was pending. Claim payment, short-side coverage and remaining maturity checks are not marked complete. Earlier failure/pending entries above remain historical checkpoints.
## Final Seeker QA readback — 01:49:53 UTC / 10:49:53 KST

The coordinator observed native wallet success for the completed Seeker chip, curve, spot, LP and Pro long/short open→close→claim flows. The final financial readback establishes the following additional completions:

| Action | Request | Finalized signature / result |
| --- | --- | --- |
| Long claim | `ae34d59c-3c7a-4a53-86d4-c7ffd85881da` | `5i7GF8BsoRAbMFprQLMwqdH6zYeRLB76efavY91HMq2pdKvAvujaHL9DxM4Zq3oiRQ5gJbL3CXd296Zj2gxrMsEz`; paid 10.326152 tUSD, wallet 999.944529 tUSD before the short flow |
| Short close | `a20cfb2d-717b-4c59-82e6-8be447699766` | `5G4uy3DM1RFGM11QAzgNXKzwvy8AcbCd5DebPSSs9JLN2RtuxdQKxY8a9LKH5f9V9smdXTVE3Qaf4x6zcPzd1ZCm`; FINALIZED |
| Short claim | `73dce29b-af52-4173-b8c7-e960ee521709` | `ipPZyH9FqkZY95Z7Qb6iQ4qyAWULb65DWYz4cv4cymPnB7p9Jf4tXSj8NWochNQaFi3qnH73j9wkf5iZdpfCi4W`; FINALIZED |

Short claim `H5BUJJVzeGmGuUJZoGoiATrNmGdXxb7bdakFTQpFRVLJ` is PAID: 10 tUSD payout + 0.207451 tUSD refund = **10.207451 tUSD**. Both long and short positions are SETTLED and their claims paid. Final test-wallet balance is **999.894497 tUSD**, with zero LP shares and zero market tokens. Pro reserve and other reserve are both zero. Vault assets are **8300.083021 tUSD**, NAV **7100.083021 tUSD**, and free capital **3000.083021 tUSD**. `outsideQ = 1000` refers to the initial QA holdings elsewhere, not residual holdings in this tester's wallet.

This closes the previously pending device close/claim paths; earlier pending and failure paragraphs preserve their observation-time history. It does not establish normal weekly maturity execution, stress safety, mainnet readiness, or completed demo recording. **Normal weekly maturity and recording remain untested/unfinished.** New-chip admission and the initial LP window are closed.

Bounded feed final readback: ApyEau has one graduation observation plus 15 refreshes (16 total), last observed at **01:49:55 UTC**. The feed container exited **0 at 01:49:59.400 UTC**, with no writer lock remaining. No restart or extension was performed. The Free gate and both synthetic feeds have finished; the actual X collector is unchanged.

Deployment remains public source `206d58d` / tested integration `78a1d10`, image `ante-up:capture-quote-78a1d10`. This closeout updates documentation only and adds no deployment, transaction or device action.
Fee reconciliation for this constant-price test: 999.997998 → 999.894497 tUSD, a net cost of **0.103501 tUSD** = spot 0.0024 + long 0.051069 + short 0.050032. Vault gain was 0.083021 tUSD and protocol income 0.02048 tUSD. The synthetic price stayed at **1.2**; these executions validate flow, costs, refunds and reserve release, not gains/losses under a changing market price. A separate post-payment empty-claim UI message correction is in progress and is not part of the recorded deployed release.
## Final empty-state UI release and Seeker record check

Integration `b478b85` clarifies empty claim/close controls in `Financial.tsx`; financial guards and payment rules are unchanged. The web-only image is `ante-up:final-empty-ui-20261013`, SHA-256 `c20c87b9edb6c778e92ea13417692a7708bede2ad062f08d770db764f7a07086`. Live/image JS `index-CBla-MRm.js` matches SHA-256 `cec1f2af06d3abe2d9515bf2b547f6c1513bfb09d128740d7ba05ad15938fcd6`; CSS remains `index-Dly_HIQq.css`. API remains `ante-up:capture-quote-78a1d10`, and `/api/v1/markets` returned 200. Linux build, API typecheck and 14 financial UI tests passed.

Root also verified the actual Seeker EfCp record page: solana, **−0.01%**, placement **00:37 UTC**, return **00:43 UTC**, **Proof pending**, and Verify record. This adds a physical-device display check to the earlier isolated-browser capture. It adds no wallet transaction or proof issuance; normal weekly maturity remains unverified.

For completeness, the successful SHORT open preceding the close/claim above was request `e303b48b-42d4-41ef-b41b-ea07373aaa9f`, signature `5rg4TSa5EFd62Xt2wANceXXmD6Cvh4EDxCb9sUtmMicDxmSyj5ShQZoCyhahZYUfWaTUtKo1sF7KhfJVVnexK1VJ`, position `CgSs5WcQ2CWgAoCRBwwz3KjRHN5BDTT5BZEjZEGiTa9V`: collateral 10 tUSD, notional 50 tUSD, 5× leverage, entry price 1.2, maximum payout 60 tUSD, prepaid cost 0.207483 tUSD. This is the already-completed short flow, not an additional position.