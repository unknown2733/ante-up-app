# Isolated PC browser regression

Install module lockfile dependencies and build `clients/chain` first. Set
`ANTE_UP_CHROMIUM` to an installed Chrome/Edge executable. Runs use a new ignored
profile under `.runtime`; they never attach to the user's browser or wallet.

From the repository root:

```sh
node scripts/consumer-real-browser.mjs --dist PATH_TO_PRODUCTION_DIST --source-sha SHA --focus-transactions
node scripts/consumer-real-browser.mjs --dist PATH_TO_PRODUCTION_DIST --source-sha SHA --focus-trends
node scripts/consumer-real-browser.mjs --dist PATH_TO_PRODUCTION_DIST --source-sha SHA --focus-sync
node scripts/result-card-browser.mjs --dist PATH_TO_PRODUCTION_DIST --source-sha SHA
node scripts/wallet-fixture-browser.mjs SHA
node --test scripts/public-qa-fetch.test.mjs scripts/browser-assert-adapter.test.mjs
```

Use actual deployed assets or a production Devnet build verified with
`scripts/assert-live-web-build.mjs`. A fixture build has a different API mode
and cannot validate live-market UI. Record the web asset revision separately
from the API/main revision, and compare public JS/CSS hashes before a release
claim. `--direct-live` uses the public origin directly; keep 429/network failures
in its report. Fault injection is refused in that mode.

The regular consumer runner uses a localhost GET-only proxy and bounded,
serialized public reads. Successful identical responses form a per-run snapshot.
Only 429 responses receive bounded retries; other errors remain visible. The
sync scenarios replace only the localhost market response: hold SYNCING until
its paused state is observed, release, then verify a later automatic request.
Also check STALE, injected 503, manual retry, and a late response after a market
switch. Only the exact injected market 503 console error is expected; all other
browser errors fail. No source observation or server state is modified.

Wallet fixtures bundle production modules and reuse existing free/financial/
transaction tests in Chromium. A small assertion/Vite adapter supplies only
fixture module imports, isolated in-memory storage, base64 encoding, and a
browser equivalent of the Node event-loop yield. Network interception permits
only localhost GET files. It also mounts the real `FinancialMarket` component
with a test wallet/flow to check busy and pending request retention through
refresh, zero extra signature attempts, and prepared-quote signing gates.
These are fixture adapters, not wallet extension or on-chain verification.

Reports and screenshots retain both failures and successes under `.runtime`.
The share-card runner uses public real records plus explicitly named local
variants; clipboard and native sharing are replaced inside the isolated page.
It downloads real PNG bytes and compares the share payload hash. It does not
post to a social network or overwrite the user's clipboard.
