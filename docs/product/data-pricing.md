# Data and pricing

Check the source, metric, and observation date on each chart. Observed Devnet markets use collected attention data. Preview subjects show available public reference data or official information; they have no token price or executable quote.

## Public reference data

Where available, preview charts use fetched Wikimedia article pageviews. These count visits to the named Wikipedia article, not video views, song plays, or album streams. Read the displayed article, date range, and source link to understand the measurement. Other previews provide official metadata or artwork without inventing a history. A reference chart does not feed chip results or settlement.

## Attention reference

The implemented X Counts path aggregates configured English keyword queries into minute observations. A valid zero differs from a missing observation. The activity index uses an exponentially weighted moving average with a **three day half-life**. Its comparison point is the index from **exactly seven days earlier**. The formula version is `h3-d7-q12-v1`.

The operator controls registered queries and publishes accepted snapshots. An on-chain value does not independently verify the source counts. Corrections are versioned and finalized historical results retain the observations actually used. A gap, low activity, or stale data can restrict new financial entry and produce an N/A chip result.

## Test-asset price

The bonding curve and later index price use the program's fixed graduation anchor and market state. A chart reference is not necessarily an executable quote. Financial actions request a short-lived quote and recheck the prepared transaction before signing. The previously deployed price sampler recorded finalized-chain samples every five minutes; earlier unobserved history is not manufactured.

No exchange rate, return, provider fee, or expected yield is promised here. Check each current quote for test-asset amounts and limits.

## Read next

- [Markets and trading](/docs/markets-trading)
- [Records and proofs](/docs/records-proofs)
