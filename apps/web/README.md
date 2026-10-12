# Ante Up mobile web — F first slice

React, Vite and TypeScript client for shared contract revision 0.2 (wire schema `0.1`). It starts as a **fixture demo**, with no real wallet connection, Solana transaction, X data, Arweave upload or SAS issuance.

## Run

```sh
cd clients/chain
npm ci
cd ../../apps/web
npm ci
npm run dev
npm test
npm run build
```

Open the local Vite URL and use `/markets`, `/markets/:id`, `/me`, `/u/:wallet`, `/leaderboard`, and `/records/:id`. Fixture records changed by the free chip controls are stored in this browser's `localStorage`. The seeded leaderboard is a fixed fixture snapshot and does not recompute from those local changes.

## D HTTP fixture API

Start D's local server on `127.0.0.1:8787`, then start the web server with:

```powershell
$env:VITE_API_BASE_URL = '/api'
$env:VITE_ALLOW_FIXTURE_API = 'true'
npm run dev
```

The Vite development proxy forwards `/api/v1/*` to `http://127.0.0.1:8787/v1/*`. Set `VITE_API_PROXY_TARGET` to a different local origin if needed. An explicit origin in `VITE_API_BASE_URL` also works when the API allows the browser origin. Without `VITE_ALLOW_FIXTURE_API=true`, an HTTP `mode: fixture` response is rejected; it is never relabeled as devnet. Transport errors never switch to local fixture data. HTTP fixture responses never enable wallet writes.

`VITE_WALLET_CLUSTER` selects `devnet` (default) or `localnet`. On Android over HTTPS, the page registers Mobile Wallet Adapter with `VITE_MWA_APP_URI` as its app identity URL; when unset, it uses the HTTPS page origin. A compatible wallet must support the selected chain. This is a browser wallet connection, not an installed app or a Seeker device validation.

`src/liveFree.ts` is the API mode free open/close adapter. It requests `/v1/auth`, checks the exact challenge text, signs its UTF-8 bytes with Wallet Standard, exchanges the signature at `/v1/auth/session`, and keeps the bearer token in memory only. It then calls `/v1/transactions/prepare`, signs and sends only validated bytes, reports the returned signature once to `/v1/operations/:requestId/submit`, and polls `/v1/operations/:requestId?wallet=...` for a matching finalized operation. The market button is enabled only for a matching localnet/devnet wallet, chain market PDA/program, message signing, transaction signing and an allowed free capability. The current D fixture API still returns `notExecutable`, so it cannot send a transaction.

`src/transactionBoundary.ts` checks wallet, cluster, action, request ID, record ID, expected program, expiry, fee payer, unsigned signatures and transaction version. `src/freeInstructionVerifier.ts` uses the built `@ante-up/chain-client` dist exports to check the open/close discriminator, account roles, signer, market/record accounts and generated PDAs. A wallet response alone never proves finality. `UNKNOWN` blocks a repeat send; the UI can manually recheck the existing request ID, including when the wallet response lost its signature. Install both lockfiles once as shown above; web `predev`, `prebuild` and `pretest` rebuild the chain client without reinstalling dependencies.

The adapter reads `/v1` envelopes and uses shared `LeaderboardPage` and `ProofStatus` types. It gets a proof from `/v1/proofs/:proofId` using `FreeRecord.proofId`. D's optional `PublicProfile.openPreviews` is displayed as a non-final reference value with its observation time. The current fixture D API is read-only and returns no executable transaction.

The D response test uses its actual `createApp` over a loopback HTTP server (it does not write in D's clone):

```powershell
$env:ANTE_UP_D_APP_PATH = 'C:/path/to/ante-up-api/ante-up/services/api/src/app.ts'
npm run test:integration
```

The fixture wallet is an identifier for local interaction only. Wallet SDK auto-connect and MWA registration are disabled in fixture mode. No install prompt or PWA assets are included.

Official setup references checked on 2026-10-12: [Vite React TypeScript template](https://vite.dev/guide/) and [React TypeScript guide](https://react.dev/learn/typescript).
