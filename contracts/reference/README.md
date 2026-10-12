# Platform metric snapshots

The production reference catalog is `platform-snapshot.ts`: **nine actual subjects**, with original artwork or attached media and one verified cumulative count each. The app shows YouTube video views, X post likes, and Spotify track streams, without substituting another site's attention metric. They have no executable token quote, trading rights, chip events, wallet identity, or fabricated price history.

## Captured counts

| Platform | Actual subject | Count | Source / observation |
| --- | --- | ---: | --- |
| YouTube | Bonobo — Kerala (Official Audio) | 14,169,301 views | Official watch page, Oct 12, 2026 22:13 UTC |
| YouTube | Khruangbin — May Ninth (Official Video) | 2,787,678 views | Official watch page, same capture |
| YouTube | NASA — Artemis I highlights | 419,821 views | Official watch page, same capture |
| X | @CatWorkers — Road safety cat | 3,857 likes | Official public embed, Oct 12, 2026 22:12 UTC |
| X | @Catsillyness — What song? | 3,180 likes | Official public embed, same capture |
| X | @thedispenser_ — Cat interrupts filming | 22,335 likes | Official public embed, same capture |
| Spotify | Tycho — Awake | 112,965,561 streams | Kworb report dated Sep 25, 2026 |
| Spotify | Bonobo — Rosewood | 48,661,771 streams | Kworb report dated Oct 2, 2026 |
| Spotify | Khruangbin — May Ninth | 64,000,726 streams | Kworb report dated Oct 9, 2026 |

The Spotify rows are explicitly **third-party reported Spotify totals**. The exact track URLs and covers were checked on Spotify. Its public [track API schema](https://developer.spotify.com/documentation/web-api/reference/get-track) does not supply a cumulative play count. A popularity score is not a stream count. Kworb supplies a report date without an exact time or timezone; the app preserves that date separately from the Oct 12 capture timestamp. It does not label those older totals as current platform observations.

For YouTube, the captured field is `ytInitialPlayerResponse.videoDetails.viewCount` for the exact video ID. X uses `favorite_count` for the exact post ID from the official public syndication endpoint. Platform counters may be cached: capture time means retrieval time, not the precise instant their counter updated. A short X title can be a descriptive label; the source links identify the actual post. Attached media identifies that post without asserting ownership or endorsement.

## Evidence and display rules

- `raw/youtube-*-20261012.json`, `raw/x-*-20261012.json` and `raw/spotify-*-20261012.json` preserve the minimal count-bearing extracts, capture/source information, extraction path and original response SHA-256. Each extract's own hash is recorded in `platform-snapshot.ts` and tested. Full original responses remain in the local capture archive; the extracts are not mislabeled as full responses.
- Source links and original image links appear in the app. Spotify report dates are visible in the label and snapshot card.
- One capture renders as a count card, not an invented line chart. All periods retain the same single captured observation; growth/change remains unknown. No interpolation, backfilled trades or implied oracle feed is added.
- Automatic refresh is not connected. These captures do not change the existing X keyword collector or the Devnet market. A future capture must preserve its source, exact item ID, count meaning and timestamp separately.
- `node --test apps/web/src/reference/referenceData.test.mjs` validates hashes, exact item/count correspondence, time semantics and the absence of invented financial/social state.

## Retained historical material

The earlier `catalog.ts`, `snapshot.ts`, Wikimedia raw responses and `scripts/refresh-reference-data.mjs` are preserved as historical research/evidence. Production no longer imports that catalog or uses its pageviews. Running that older refresh script cannot refresh the current platform snapshot. Synthetic fixture modules remain test-only.
