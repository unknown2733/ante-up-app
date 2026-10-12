# Public reference catalog

This catalog contains 15 actual public subjects and verified official images. It contains no invented prices, trades, chip records, notes, users, or rankings. Every entry is a non-executable `PREVIEW` with `source.mode = REFERENCE` and a `reference:` identity. These references are separate from the observed Devnet market.

The capture run began **2026-10-12 21:57:48.910 UTC** (2026-10-13 KST). `snapshot.ts` records the run timestamp, per-image verification time, source title, source URL, response hash, and exact activity interval. All 15 image URLs returned successful image responses during capture. Images remain hosted by their original providers and may subsequently become unavailable. Display attribution and fallback belong to the UI.

## Actual activity coverage

Six subjects have **45 daily observations each, August 28–October 11, 2026 UTC**. The 270 integers are direct Wikimedia API observations, preserved under `raw/` with SHA-256 hashes and compared to the web adapter in tests. The API request is scoped to `en.wikipedia.org`, `all-access`, `user`, and `daily`.

| Subject | Exact English Wikipedia article | Latest daily pageviews |
| --- | --- | ---: |
| Aurora | `Aurora` | 2,947 |
| Black holes | `Black_hole` | 5,940 |
| Mars | `Mars` | 2,797 |
| Epoch — Tycho | `Epoch_(Tycho_album)` | 11 |
| Fragments — Bonobo | `Fragments_(Bonobo_album)` | 15 |
| A LA SALA — Khruangbin | `A_La_Sala` | 21 |

The metric is **daily views of the named English Wikipedia article**. It does not measure streams, video plays, album sales, social followers, search volume, unique people, or all internet attention. Album counts belong to the album article, with no substitution of artist traffic. Wikimedia's `user` agent classification is preserved as supplied. See the [Wikimedia pageview API](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html).

Points use the UTC start of each daily bucket. The source `asOfMs` is the end of the last represented UTC day; it is distinct from capture time. `1D` has one real daily point, `1W` the last seven days, `1M` the last 30 days, and `ALL` the saved period. There are no interpolated intraday points. Missing days remain absent and break the series. `ACTIVITY_COUNT` uses `views/day`; it is never a settlement index. The optional activity change compares the last daily count with the count exactly seven days earlier, and is null if that denominator is missing or zero. Price fields and price changes remain null.

## Official identity and media sources

| Subject | Metadata and artwork provenance | History |
| --- | --- | --- |
| Aurora | [NASA Earth Observatory](https://science.nasa.gov/earth/earth-observatory/purple-haze-aurora/) Open Graph image | Article views |
| Black holes | [NASA Science](https://science.nasa.gov/universe/black-holes/) Open Graph image | Article views |
| Mars | [NASA Science](https://science.nasa.gov/mars/) Open Graph image | Article views |
| Artemis I highlights | [NASA video page](https://science.nasa.gov/resource/nasas-artemis-i-moon-mission-launch-to-splashdown-highlights/) verifies linked YouTube ID `jrDv0OdMt5s`; YouTube thumbnail | Metadata only |
| Earth at Night | [NASA video page](https://science.nasa.gov/resource/video-lights-of-human-activity-shine-in-nasas-image-of-earth-at-night/) verifies linked YouTube ID `2TKuumpbcXc`; YouTube thumbnail | Metadata only |
| Unfold the Universe | [NASA video page](https://science.nasa.gov/resource/its-time-to-unfold-the-universe/) verifies linked YouTube ID `69uT90tEJdE`; YouTube thumbnail | Metadata only |
| Awake — Tycho | [Artist Bandcamp track](https://tycho.bandcamp.com/track/awake) Open Graph artwork | Metadata only |
| Rosewood — Bonobo | [Artist Bandcamp track](https://bonobomusic.bandcamp.com/track/rosewood) Open Graph artwork | Metadata only |
| May Ninth — Khruangbin | [Artist Bandcamp track](https://khruangbin.bandcamp.com/track/may-ninth) Open Graph artwork | Metadata only |
| Epoch — Tycho | [Artist Bandcamp album](https://tycho.bandcamp.com/album/epoch) Open Graph artwork | Article views |
| Fragments — Bonobo | [Artist Bandcamp album](https://bonobomusic.bandcamp.com/album/fragments) Open Graph artwork | Article views |
| A LA SALA — Khruangbin | [Artist Bandcamp album](https://khruangbin.bandcamp.com/album/a-la-sala) Open Graph artwork | Article views |
| Svelte | [GitHub organization API](https://api.github.com/orgs/sveltejs), public organization identity and avatar | Metadata only |
| Vite | [GitHub organization API](https://api.github.com/orgs/vitejs), public organization identity and avatar | Metadata only |
| Deno | [GitHub organization API](https://api.github.com/orgs/denoland), public organization identity and avatar | Metadata only |

Artwork identifies its actual subject; no endorsement or ownership claim is made. The catalog's `imageSourceUrl` links back to the provider, and `imageAlt` identifies the work or organization. No music or video binary was downloaded. The GitHub entries are real organization accounts, not participant profiles. The nine metadata-only subjects deliberately have no chart series because no supported historical metric was collected for those exact subjects.

## Manual refresh and validation

Run `node scripts/refresh-reference-data.mjs` from the repository root with Node 24 and public network access. It performs public GET requests without credentials or paid APIs, requests 45 days ending on the previous UTC day, checks identity and image responses, validates exact Wikimedia metric dimensions, and saves the actual returned interval. If a required source fails, it stops before replacing the current snapshot. New captures preserve old raw responses under unique filenames. Refresh is manual; a static deployment does not become a live feed.

Run `node --test apps/web/src/reference/referenceData.test.mjs` to check preserved response hashes, exact chart observations, non-executable and non-social boundaries, period selection, metadata-only behavior, and object isolation. The old synthetic fixture modules remain available solely for tests and must not be imported by production routing.
