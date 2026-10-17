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
