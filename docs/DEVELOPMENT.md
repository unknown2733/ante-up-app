# Development

Ante Up is a Solana Devnet application. The public repository contains source,
tests, product articles, and example configuration. It does not contain operator
keys, service state, deployment journals, or internal coordination notes.

## Local preview

Use Node.js 24+, npm, and Git. Dependencies are pinned per module; there is no
root npm workspace.

```sh
node scripts/install-dependencies.mjs --plan
node scripts/install-dependencies.mjs
npm --prefix clients/chain run build
node scripts/doctor.mjs
node scripts/preview-integration.mjs
```

The preview runs on `http://127.0.0.1:5194` with a fixture API. It does not
submit transactions or use paid data sources. Stop it with Ctrl+C.

## Verification

```sh
node scripts/verify-integration.mjs
node scripts/doctor.mjs --require-chain
```

The first command runs module checks and integration tests. Native SBF and
LiteSVM checks depend on a Solana toolchain and should be reported separately
when unavailable. A local fixture test does not establish Devnet finality.

## Architecture boundaries

- `programs/` defines on-chain rights, reservations, and settlement.
- `contracts/` holds shared DTOs, reference calculations, and test vectors.
- `clients/chain/` contains generated account and instruction clients.
- `services/data/` collects and validates source observations before publishing.
- `services/indexer/` projects finalized chain state.
- `services/api/` prepares wallet-bound operations and serves read models.
- `services/evidence/` handles archival and attestations.
- `services/keeper/` plans bounded maturity actions.
- `apps/web/` provides the browser and mobile-web experience.

Use `docs/product/` for user-facing rules. Check source and tests when changing
financial behavior; historical project notes are intentionally outside this
public repository.

## Credentials and deployment

Copy only the relevant module `.env.example` files. Keep RPC URLs with embedded
API keys, publisher and keeper keypairs, provider tokens, uploader keys, webhook
receivers, and persistent SQLite/JSON state outside Git and container images.
`VITE_*` variables become public browser inputs. The examples in `deploy/` are
templates, not live operator configuration. For the optional YouTube collector,
set `ANTE_UP_HOST_STATE_DIR` and `ANTE_UP_YOUTUBE_API_KEY_FILE` to private host
paths before invoking `deploy/run-reference-youtube.sh` with a reviewed image.

Devnet deployment requires explicit operator setup and current chain checks.
Do not infer live service health or economic safety from a passing local test.

## Paid X market approval

Before approving a newly registered market, use the read-only Devnet inspector
to see its exact curve inventory, latest on-chain observation, and approval
status. It opens no signer and makes no paid X request:

```sh
ANTE_UP_RPC_URL_FILE=/absolute/path/devnet-rpc.url ANTE_UP_APPROVED_X_MARKETS_PATH=/absolute/path/approved-x-markets.json node scripts/market-activation-preflight.mjs MARKET_PDA
```

This is a preliminary gate. The existing `graduate-market.mjs` finalized plan
must still verify the full funding, liability, source freshness, and account
conditions before any graduation transaction.

All approved collectors also share one durable X spending ledger. Its limits
are $10 per UTC day, $100 for historical initialization, and $150 total across
all markets. Every paid request reserves its estimated cost before reaching X;
failed or uncertain requests retain their reservation. The shared SQLite file
must be initialized from **all** existing collection journals while the paid
collectors are stopped:

```sh
node scripts/seed-global-x-budget.mjs --plan /absolute/path/global-x-budget.sqlite /absolute/path/solana/collection.json /absolute/path/tariff/collection.json
node scripts/seed-global-x-budget.mjs --apply /absolute/path/global-x-budget.sqlite /absolute/path/solana/collection.json /absolute/path/tariff/collection.json
```

Only after the seed succeeds, mount that same file path in every paid collector
as `ANTE_UP_GLOBAL_X_BUDGET_DB`. A missing ledger stops paid collection. When
adding a market, include its existing collection journal in the baseline or
start it with a fresh empty journal; never create an independent ledger for it.

Market registration and curve trading are separate from paid X collection.
Collectors require an operator-owned `approved-x-markets.json` in mounted
service state. The registry allows at most five market IDs and binds each
approval to its market seed, query hash, and query version. The collector checks
it before each paid source call. An environment opt-in or collection config by
itself cannot authorize spending.

For a new market, prepare a collection config with explicit initial, daily,
and total cost limits. Review it, then run:

```sh
node scripts/approve-paid-x-market.mjs --plan /absolute/path/approved-x-markets.json /absolute/path/collection-config.json
node scripts/approve-paid-x-market.mjs --apply /absolute/path/approved-x-markets.json /absolute/path/collection-config.json
```

The apply step writes the registry atomically and is idempotent. It does not
start a collector, buy data, publish observations, provide graduation capital,
or open Pro trading. Those steps require their own chain and budget checks.
