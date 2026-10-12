# Local SDK integration and hosting

This checkout is the integration workspace. Local checks require no X account, paid storage, deployed program, or wallet funding. As of2026-10-12 actual provider connections and Devnet are configured on the home server; see [continuous runtime and verification](ALWAYS_ON_DEVNET.md). Earlier local-only boundaries below describe the original harness, not the current server deployment.

## Reproduce the local build

Use Node 24+ and npm from the repository root:

```sh
node scripts/install-dependencies.mjs --plan
node scripts/install-dependencies.mjs
node scripts/doctor.mjs
node scripts/verify-integration.mjs
node scripts/preview-integration.mjs
```

Installation uses each module's lockfile. Verification builds the generated chain client before consumer tests, runs actual loopback HTTP tests, and builds the web app. A skipped LiteSVM test means compiled program execution has **not** passed. `doctor` inventories the current process environment; workspace-local tools used in another checkout are not automatically on this checkout's PATH.

The preview is explicitly a fixture demonstration. No fallback changes a failed live request into a fixture success.

## Home server process boundaries

| Process | Entry point / module | Persistent state | Current boundary |
|---|---|---|---|
| Web | `node scripts/serve-web.mjs` | Built `apps/web/dist` | SPA routes and fixed `/api` reverse proxy; separate API process |
| API | `services/api/src/server.ts` | SQLite wallet sessions, prepared intents, operations and finalized projection | Default fixture; explicit `ANTE_UP_MODE=localnet/devnet` constructs Kit live adapters |
| Indexer | `services/indexer/src/run.ts` | SQLite projection, events, candidate/proof repositories and cursors | Finalized RPC reads; C/E files reloaded each poll; `--follow` keeps polling |
| Counts worker | `services/data/cli.mjs` | Collection journal and raw responses | Explicit execution and budget gate; collection alone is not publication |
| Evidence worker | `services/evidence/cli.mjs` | Proof journal, receipts and manifests | Explicit runtime adapters and execution gate; upload acceptance is not completed storage |
| Chain | `clients/chain` + Anchor programs | Solana accounts | Generated codecs/builders; deployment and program execution are separate |

State paths should be inside ignored `.runtime/` directories for development. A server deployment should mount persistent volumes and back them up; rebuilding a container must not erase journals, cursors, receipts, or keys. The JSON workers currently require one writer; process duplication is not a scaling strategy. SQLite uses its own transaction boundary for projection/cursor changes.

Serve mobile traffic over HTTPS through the home server's reverse proxy. Set `API_ORIGIN` to the local API origin, and configure `WEB_HOST` / `WEB_PORT` to suit that proxy. For an API-connected web build use `VITE_API_BASE_URL=/api`; keep `VITE_ALLOW_FIXTURE_API` disabled for a real network. Vite variables are public build inputs: put no provider secrets or issuer keys in them.

## Provider and program configuration

The module `.env.example` files contain placeholders, not usable credentials. Node does not load these examples automatically. Load an ignored environment file explicitly (for example `node --env-file=<path> <entrypoint>`) or supply environment variables through the process manager.

- X: operator bearer token, supported query set, archive access, budget estimate and collection directory. Archive pagination and gap fill are implemented with injected transport tests; actual access and billing still require provider checks.
- RPC: localnet or Devnet URL, the deployed program ID, persistent indexer DB, and the configured generated decoder/candidate repository.
- Program: the committed IDL uses a fixture program ID with no deployment keypair. Actual deployment requires updating the program identity and regenerating consumers consistently. There is no mainnet mode.
- Evidence: Turbo signer and receipt verification, retained calculation inputs, SAS issuer credential/schema matching the canonical claims codec, and explicit attestation expiry. Finalized readers and Kit SAS/completeProof senders are provided; actual storage receipt/inclusion verification and live execution remain separate gates.
- Wallet: Wallet Standard on desktop; MWA registration on an Android HTTPS page. Device verification is still required.

## Live free-record wiring

The same `ANTE_UP_PROGRAM_ID`, cluster, market registry and absolute SQLite path must be used by API, indexer and workers. Registry entries have `{address,seedHex,keyword,aliases}`: `address` is the actual market PDA; `seedHex` is the 32-byte registration seed. A keyword label or logical ID is not a market address.

1. Generate the client from the deployed program identity, initialize config/admission and register the supported markets. Existing builders support this; no keypair is bundled.
2. Run Counts collection and publication using `services/data/cli.mjs --execute --publish` and the explicit paid-call gate. Retain raw responses, replay inputs and the candidate repository. See that module's `.env.example` and README for initialization.
3. Run `services/indexer/src/run.ts --follow` with candidate/proof paths. The API points at the same database. Unresolved evidence holds the indexing cursor; it is retried after refreshed repositories are loaded.
4. Run `services/api/src/server.ts` with its `.env.example` filled in an ignored environment file. Start the built web app using `scripts/serve-web.mjs`, `API_ORIGIN`, and an API-mode build (`VITE_API_BASE_URL=/api`).
5. Free open/close uses a wallet-signed challenge, an expiring bearer session, API-prepared unsigned transaction, wallet send, signature reporting and finalized receipt reconciliation. The API verifies the exact prepared message and wallet signature. An unknown send is rechecked, never automatically resent. The web proxy forwards Authorization but not browser cookies.
6. The evidence worker joins finalized records with retained publication inputs, archives exact bytes, validates the packet, issues SAS and records the proof hash on chain. Its paid/storage gate is independent of web GET requests. See the evidence module's runtime configuration instructions.

`PREPARING`, `LOW_ACTIVITY` and `OUTAGE` do not themselves forbid free recording. Missing usable snapshots yield N/A rather than fabricated performance. Admission/storage limits can still stop new records; existing closes remain separate. Financial availability is action-specific and must come from the live adapter; unsupported or unverified actions remain unavailable.

These commands describe configured execution. The no-key suite replaces RPC/storage endpoints with injected transports; it does not prove a deployed program or actual provider response.

## Test-asset bootstrap

After deploying the matching program and initializing its core config, `scripts/bootstrap-finance.mjs` prepares the classic SPL payment mint, admin treasury ATA, initial 50,000 tUSD support capital, mint-authority transfer to the finance-config PDA, and finance initialization. It does not deploy the program or create the core config. The 1,000 tUSD per 24-hour faucet allowance is a configurable development default; its global cap must be set explicitly. SOL transaction fees remain separate.

```sh
# Offline plan: no signer or network access.
node --env-file=<ignored-bootstrap-env> scripts/bootstrap-finance.mjs
# Explicit configured execution, only after reviewing the plan and prerequisites.
node --env-file=<ignored-bootstrap-env> scripts/bootstrap-finance.mjs --execute
```

The execute path verifies the selected localnet/devnet genesis hash, signer identities and finalized account state. Keep the journal on a persistent volume. A signed but uncertain send remains pending; restarting must reconcile its signature and account state rather than minting again. See `scripts/bootstrap-finance.mjs` for the `ANTE_UP_BOOTSTRAP_*` input schema; keypair contents must never enter Vite variables or Git.

The integrated Rust source includes actual checked SPL transfers for faucet, curve/graduation, spot, Pro collateral/claims and LP. Its generated client is available to the API and web. This is implementation evidence, not evidence of execution in a Solana VM. The latest integration report records which API and browser adapters have also been verified.

## Remaining execution gates

### Settings handoff checked on 2026-10-12

The separate setup chat reports successful X recent/all Counts probe requests, Helius Devnet identity verification, server signer preparation and Turbo wallet setup. Its Linux SBF build and 14 passing LiteSVM tests used **7283998784d75b8557619dcf2a11759195d54347**. That result predates the indexed spot/Pro/LP implementation and must not be applied to the latest integrated source. SAS credential/schema, actual archive upload/inclusion and application service deployment remain pending.

The deployment public key is `FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr`. Commit `4b658eb` applies it to the declaration, configuration, compiled IDL and generated consumers. The latest Linux SBF/client suite passes all 16 tests, including financial execution. See [DEVNET_DEPLOYMENT.md](DEVNET_DEPLOYMENT.md) for deployment progress. No key material belongs in this document.

### Graduation and epoch operations

`node --env-file=<ignored-graduation-env> scripts/graduate-market.mjs` defaults to a plan. With RPC settings it checks finalized reserves, supported-market contribution caps and the graduation observation. `--execute` additionally requires the configured administrator keypair and persistent send journal. It does not substitute for bootstrap or valid data publication.

`node services/api/src/keeper-run.ts --scope <scope.json> --journal <candidate-journal.json> --rpc <rpc-url>` plans one epoch step. Execution additionally requires `--execute`, `--expected-genesis-hash`, `--attempts`, `--publisher-keypair` and `--keeper-keypair`. Scope epoch is the on-chain `current_cycle`, not a calendar-week number. Each run advances at most one instruction; persist and reconcile signed attempts before retrying. Inspect the CLI schema before configuring process supervision.

Native Rust arithmetic and host Anchor/IDL compilation can succeed without producing a Solana SBF binary. The Windows host lacks the required working SBF linker combination, and the selected LiteSVM package does not ship a Windows native binding. Run compiled program tests in a compatible Linux toolchain before describing the chain flow as verified.

No live X request, permanent upload, SAS issuance, faucet payment, mobile wallet transaction, or public deployment is established by the local test suite. Verify actual account balances, reservation conservation and failure behavior with the compiled program before opening the configured financial flow. These are execution gates, not changes to the accepted product scope.

Public deployment order: backend processes and persistent state → program/provider initialization → actual free and financial end-to-end checks → frontend API build and mobile wallet checks → domain/HTTPS and public release. Domain ownership or DNS preparation does not establish backend readiness.
