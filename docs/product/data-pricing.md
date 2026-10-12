# Data and pricing

Check the source, metric, and date on each subject. Observed Devnet markets use collected attention data. Preview subjects show captured platform counts or official information; they have no token price or executable quote.

## Public reference data

Reference metrics identify the activity counted: YouTube video views, X post likes, or Spotify track streams. Each snapshot shows its count, unit, source link, and capture time in UTC. A provider's report date is shown separately when supplied; an unspecified time zone remains unspecified. Platform counters may be cached. Spotify stream counts from third-party reports retain the provider's name and report date; a popularity score is not a stream count.

A single observation appears as a snapshot. A history requires multiple recorded observations, and a change requires comparable counts from different times. Captured counts are not continuously updated feeds. Subjects without a verified count show available metadata and artwork. Reference counts do not feed chip results or settlement.

## Reading historical activity

- **Cumulative activity:** Rosewood and May Ninth show Spotify stream totals at three verified report dates each. These are sparse observations; the chart leaves unobserved intervals blank.
- **Daily activity:** Free and Gangnam Style show daily YouTube views reported by Kworb. Blinding Lights shows Spotify Global chart-eligible streams per day, which differ from the all-stream counter on a song page.
- **Dates and ranges:** 1D, 1W, and 1M end at the latest available report, not today. All shows the complete imported history. Report dates do not imply a time of day or time zone. Open **View recorded observations** for exact dates, values, and source links.

Daily counts can rise or fall as activity changes. Missing days in the measured series are unknown, not zero. Imported history and the Devnet market connection are separate.

## Illustrative trends

Subjects with fewer than four verified observations also offer an **Illustrative trend** to preview the chart experience. Its temporary values use a preview index ending at 100; its shape, dates and percentage change are illustrative, not historical measurements or forecasts. This display-only series cannot affect chip results, rankings, proofs or settlement. The original observed counts remain available through the source metric selector. Subjects with sufficient daily history continue to show their measured series.

## Attention reference

The implemented X Counts path aggregates configured English keyword queries into minute observations. A valid zero differs from a missing observation. The activity index uses an exponentially weighted moving average with a **three day half-life**. Its comparison point is the index from **exactly seven days earlier**. The formula version is `h3-d7-q12-v1`.

The operator controls registered queries and publishes accepted snapshots. An on-chain value does not independently verify the source counts. Corrections are versioned and finalized historical results retain the observations actually used. A gap, low activity, or stale data can restrict new financial entry and produce an N/A chip result.

## Test-asset price

The bonding curve and later index price use the program's fixed graduation anchor and market state. A chart reference is not necessarily an executable quote. Financial actions request a short-lived quote and recheck the prepared transaction before signing. The previously deployed price sampler recorded finalized-chain samples every five minutes; earlier unobserved history is not manufactured.

No exchange rate, return, provider fee, or expected yield is promised here. Check each current quote for test-asset amounts and limits.

## Read next

- [Markets and trading](/docs/markets-trading)
- [Records and proofs](/docs/records-proofs)
