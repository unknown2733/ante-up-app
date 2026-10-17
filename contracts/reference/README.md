# Platform metric snapshots

The reference catalog combines `platform-snapshot.ts` (**nine actual subjects**, each with a verified cumulative count) and `platform-history.ts` (**five verified histories**, including three additional subjects). Together these describe 12 distinct subjects. The app shows YouTube video views, X post likes, and Spotify track streams, without substituting another site's attention metric. They have no executable token quote, trading rights, chip events, wallet identity, or fabricated price history.

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
- Subjects with only one capture render a count card. Available multi-date histories use only their recorded points. Sparse gaps remain unknown, with no interpolated observations or backfilled trades.
- The source now includes an append-only SQLite observation path and 60-second web refresh for newly imported, verified counts. The provider collectors and production deployment are separate steps; the checked-in captures remain the displayed baseline until new evidence is imported. This path does not change the X keyword collector or Devnet settlement.
- `node --test apps/web/src/reference/referenceData.test.mjs` validates hashes, exact item/count correspondence, time semantics and the absence of invented financial/social state.

## Retained historical material

The earlier `catalog.ts`, `snapshot.ts`, Wikimedia raw responses and `scripts/refresh-reference-data.mjs` are preserved as historical research/evidence. Production no longer imports that catalog or uses its pageviews. Running that older refresh script cannot refresh the current platform snapshot. Synthetic fixture modules remain test-only.

## Verified platform history

`platform-history.ts` exports `historyReferences`, with types in `history-types.ts`. These **61 actual provider observations across five histories** were retrieved on October 12, 2026 UTC. Each point carries its exact source URL and the SHA-256 of a minimal extract under `raw/history-*-20261012.json`. Each extract preserves the original response hash, provider date, capture time, and exact count. Full original HTML responses remain in the local research archive; these JSON files are count-bearing extracts, not full responses.

| Exact subject | Aggregation and source | Recorded dates | Points |
| --- | --- | --- | ---: |
| [Rosewood — Bonobo](https://open.spotify.com/track/2ZaL63zLMDr6H18El2EIt9) | Kworb cumulative Spotify streams | 2026-06-28, 2026-09-08, 2026-10-02 | 3 |
| [May Ninth — Khruangbin](https://open.spotify.com/track/5yVGW2o9LXaiiS4I3HUM3k) | Kworb cumulative Spotify streams | 2026-02-27, 2026-04-10, 2026-10-09 | 3 |
| [Free — Rumi - Topic](https://www.youtube.com/watch?v=HyQn-jkug-w) | [Kworb daily YouTube views](https://kworb.net/youtube/video/HyQn-jkug-w.html) | 2026-09-30 through 2026-10-11 | 12 |
| [PSY — GANGNAM STYLE](https://www.youtube.com/watch?v=9bZkp7q19f0) | [Kworb daily YouTube views](https://kworb.net/youtube/video/9bZkp7q19f0.html) | 2026-09-28 through 2026-10-09 | 12 |
| [Blinding Lights — The Weeknd](https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b) | [Kworb daily Spotify Global chart streams](https://kworb.net/spotify/track/0VjIjW4GlUZAMYd2vXMi3b.html) | 2026-09-11 through 2026-10-11 | 31 |

Rosewood's earlier totals are 47,202,777 and 48,306,333, preserved in [the June archive](https://web.archive.org/web/20260630000831id_/https://kworb.net/spotify/artist/0cmWgDlu9CwTgxPhf403hb_songs.html) and [the September archive](https://web.archive.org/web/20260913064450id_/https://kworb.net/spotify/artist/0cmWgDlu9CwTgxPhf403hb_songs.html). May Ninth's earlier totals are 56,146,919 and 57,709,051, preserved in [the March archive](https://web.archive.org/web/20260303043811id_/https://kworb.net/spotify/artist/2mVVjNmdjXZZDvhgQWiakk_songs.html) and [the April archive](https://web.archive.org/web/20260411230556id_/https://kworb.net/spotify/artist/2mVVjNmdjXZZDvhgQWiakk_songs.html). The point dates use each page's **Last updated** date; the archive capture dates are separate evidence fields. Both archived rows link the exact current Spotify track IDs.

Daily observations are increments for the stated provider day, while cumulative observations are totals as of their stated provider date. `aggregation`, `label`, and `scope` preserve that distinction. `chartEligible: true` applies only to Blinding Lights: these are **Spotify Global chart-eligible streams**, not its cumulative all-play counter. Missing or off-chart dates must not become zero. The YouTube daily tables are third-party reported figures; Kworb's explicitly estimated monthly and yearly tables are excluded. No exact provider timezone or time of day is asserted for date-only rows.

The three added subjects' exact identities and artwork were checked against their official YouTube/Spotify pages at 22:35 UTC. Free is the upload by **Rumi - Topic**, and the Gangnam Style upload belongs to **officialpsy**. Metadata verification is separate from historical count capture. No history from another upload, album edition, artist, or account was substituted.

## Observation import path (source implementation)

`services/api/src/reference-observations.ts` stores count, exact subject, aggregation, capture/report time, source URL, and the raw response bytes under their SHA-256 in the API's persistent SQLite database. A later dated report can revise one reported day without erasing the earlier capture. The read-only `/v1/reference/latest` and `/v1/reference/history/:slug?sinceMs=...` routes serve this catalog separately from executable `/v1/consumer/markets`. The web checks again every 60 seconds while visible; an API outage leaves the last checked-in dated capture visible rather than inventing a new count.

An operator import takes three arguments: `node services/api/src/reference-ingest.ts <persistent-api-db.sqlite> <observation.json> <raw-response-file>`. It verifies the raw SHA-256 before insertion. The observation JSON follows `contracts/reference/observations.ts`; a source-specific collector must extract and verify the actual count and exact subject ID before creating it. Never put API keys in the browser bundle, observation JSON, public source URL, or raw response.

The YouTube adapter, `services/api/src/reference-youtube.ts`, makes one official [YouTube `videos.list` statistics call](https://developers.google.com/youtube/data/reference/rest/v3/videos/list) for the three approved cumulative-view subjects and validates each exact video ID and decimal count. It sends the key in the `x-goog-api-key` header, never in the request URL. For repeated operation, run `ANTE_UP_YOUTUBE_API_KEY_FILE=<secret-file> ANTE_UP_YOUTUBE_ALLOW_QUOTA=1 node services/api/src/reference-youtube-schedule.ts <persistent-api-db.sqlite>`; the home-server launcher is `deploy/run-reference-youtube.sh <reviewed-image-tag>`. It reserves each request in SQLite before network use, including failed and uncertain calls, and permits at most one attempt every six hours, four per UTC day, and 120 in any rolling 30 days. The key file lives outside the repository. On October 17, 2026, the first real provider call added three observations to the public API; the home-server user timer is enabled for 00:20, 06:20, 12:20 and 18:20 UTC. The first scheduled subsequent observation and two-point live chart remain to be verified.

The X adapter, `services/api/src/reference-x-posts.ts`, requests `public_metrics.like_count` for the exact three approved post IDs in one [official Post Lookup batch](https://docs.x.com/x-api/posts/get-posts-by-ids). A single deliberate run uses `ANTE_UP_X_BEARER_TOKEN_FILE=<secret-file> ANTE_UP_X_POST_LOOKUP_ALLOW_PAID=1 node services/api/src/reference-x-posts.ts <persistent-api-db.sqlite>`. The bearer token file stays outside the repository. [X currently prices Post reads per returned resource](https://docs.x.com/x-api/getting-started/pricing); at the listed $0.005 rate, three returned posts cost up to $0.015 per run. The code is allowlisted to these IDs. Missing or deleted posts are reported as missing and never converted to zero likes.

For scheduled execution, invoke `reference-x-schedule.ts` instead of the direct adapter with the same arguments and environment. It persistently reserves an attempt before network use, including failed and uncertain calls, and permits at most one attempt every six hours, four per UTC day, and 120 in any rolling 30 days. At the current listed maximum for three returned posts this is at most $1.80 per rolling 30 days; pricing may change and the operator must recheck before continuing. A host scheduler and monitoring are separate deployment steps. Spotify report updates remain unconnected. Source adapters, schedules, costs, and live readback must be checked before describing these subjects as automatically updated.

Run `node --test contracts/reference/history.test.mjs` for exact date/value coverage, source extract hashes, per-point evidence correspondence, original subject identity preservation, and cumulative/daily/chart scope boundaries. This saved history does not imply an automatic update service; adding later observations requires another verified capture.
