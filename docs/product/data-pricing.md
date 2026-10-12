# Data and pricing

Check the source, metric, and date on each subject. Observed Devnet markets use collected attention data. Preview subjects show captured platform counts or official information; they have no token price or executable quote.

## Public reference data

Reference metrics identify the activity counted: YouTube video views, X post likes, or Spotify track streams. Each snapshot shows its count, unit, source link, and capture time in UTC. A provider's report date is shown separately when supplied; an unspecified time zone remains unspecified. Platform counters may be cached. Spotify stream counts from third-party reports retain the provider's name and report date; a popularity score is not a stream count.

A single observation appears as a snapshot. A history requires multiple recorded observations, and a change requires comparable counts from different times. Captured counts are not continuously updated feeds. Subjects without a verified count show available metadata and artwork. Reference counts do not feed chip results or settlement.

## Attention reference

The implemented X Counts path aggregates configured English keyword queries into minute observations. A valid zero differs from a missing observation. The activity index uses an exponentially weighted moving average with a **three day half-life**. Its comparison point is the index from **exactly seven days earlier**. The formula version is `h3-d7-q12-v1`.

The operator controls registered queries and publishes accepted snapshots. An on-chain value does not independently verify the source counts. Corrections are versioned and finalized historical results retain the observations actually used. A gap, low activity, or stale data can restrict new financial entry and produce an N/A chip result.

## Test-asset price

The bonding curve and later index price use the program's fixed graduation anchor and market state. A chart reference is not necessarily an executable quote. Financial actions request a short-lived quote and recheck the prepared transaction before signing. The previously deployed price sampler recorded finalized-chain samples every five minutes; earlier unobserved history is not manufactured.

No exchange rate, return, provider fee, or expected yield is promised here. Check each current quote for test-asset amounts and limits.

## Read next

- [Markets and trading](/docs/markets-trading)
- [Records and proofs](/docs/records-proofs)
