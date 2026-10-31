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

The optional Spotify track reference collector reads three fixed Kworb artist
reports once per UTC day. It stores the dated source HTML and extracted stream
count in the append-only reference database. A repeated report is skipped; an
older report or a later lower cumulative count is not promoted as a new point.
Run `deploy/run-reference-kworb.sh <reviewed-image-tag>` with
`ANTE_UP_HOST_STATE_DIR` set to the private host state directory, using the
`deploy/systemd/ante-up-reference-kworb.timer` example. Kworb can report
several days late. These counts are third-party display references and do not
set a market price or settle a position.

Devnet deployment requires explicit operator setup and current chain checks.
Do not infer live service health or economic safety from a passing local test.

The weekly Devnet Keeper's host wrapper mounts two private RPC URL files. It
checks the primary endpoint's genesis before opening a signer; only an HTTP 429
at that initial read permits the secondary endpoint, whose Devnet genesis is
then checked. The selected endpoint is fixed for that invocation and passed
to scope derivation, observed candidate preparation, and the instruction
runner. An unknown submitted transaction remains in the attempt journal and
is reconciled; no signed transaction is replayed to the other endpoint.
The secondary file is optional for local read-only testing. Keep both URLs
outside the repository and validate the host wrapper before enabling cron.

## Paid X market approval

Before approving a newly registered market, use the read-only Devnet inspector
to see its exact curve inventory, latest on-chain observation, and approval
status. It opens no signer and makes no paid X request:

```sh
ANTE_UP_RPC_URL_FILE=/absolute/path/devnet-rpc.url ANTE_UP_APPROVED_X_MARKETS_PATH=/absolute/path/approved-x-markets.json node scripts/market-activation-preflight.mjs MARKET_PDA
```

For a collector feed check, also set `ANTE_UP_COLLECTION_CONFIG` to the
market's collection JSON and `ANTE_UP_GLOBAL_X_BUDGET_DB` to the shared
SQLite ledger. The inspector reads the next regular or initial request cost
against the same daily, initial, and total limits as the collector. A ledger
file alone does not mean the next paid request is affordable. The report's
`globalBudget` covers internal reservations. The inspector also reads the
collection directory's last saved regular request without making a new X call.
`LAST_SPEND_CAP_FAILURE`, a missing collection file, or another unresolved
request result keeps `collectorFeedReady` false even if the last finalized
snapshot is still within its freshness window. A saved result is not a live
reading of the provider's billing console; after the cap changes, a successful
collection must establish readiness again.

This is a preliminary gate. The existing `graduate-market.mjs` finalized plan
must still verify the full funding, liability, source freshness, and account
conditions before any graduation transaction. A Devnet `--execute` run also
requires `ANTE_UP_GRADUATE_APPROVAL_PATH` pointing to the same operator-owned
approval registry used by the paid collectors. Immediately before creating a
new signed graduation transaction, the runner matches the finalized market
PDA, seed, query hash, and version against that registry. Missing or changed
approval stops a new signature; a previously journaled uncertain transaction
can still be reconciled without sending it again.

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

Each five-minute publication creates a new rent-funded snapshot account. Keep
the operations monitor's market list aligned with the approved collectors.
The evidence admission guard writes `evidence/capacity.json` after a finalized
admission read and a Turbo balance read. Configure the optional operations
`proofCapacity` path so the observer alerts when all remaining funded chip
slots and accepted proof duties exceed available Turbo credit or the total
proof budget. A stale or invalid capacity report also raises an alert; it does
not change the on-chain admission rule.
The optional `snapshotFunding` settings in `deploy/ops/monitor.example.json`
estimate the publisher balance needed for one and three days of publications,
using the measured rent per snapshot and an explicit reserve. Recheck that
rent amount after a program/account-size change. This alert does not fund the
wallet or permit another market to be approved automatically.

For a new market, prepare a collection config with explicit initial, daily,
and total cost limits. First compare its seed, query, version, and limits to
the finalized Devnet market without making a paid request:

```sh
ANTE_UP_RPC_URL_FILE=/absolute/path/devnet-rpc.url \
ANTE_UP_APPROVED_X_MARKETS_PATH=/absolute/path/approved-x-markets.json \
node scripts/verify-paid-x-candidate.mjs MARKET_PDA /absolute/path/collection-config.json
```

`READY_FOR_OPERATOR_REVIEW` means the config matches the registered market
and one of the five approval slots is free. It is not an approval decision.
After the operator selects this market and reviews its budget, run:

```sh
node scripts/approve-paid-x-market.mjs --plan /absolute/path/approved-x-markets.json /absolute/path/collection-config.json
node scripts/approve-paid-x-market.mjs --apply /absolute/path/approved-x-markets.json /absolute/path/collection-config.json
```

The collection config must contain its container state directory (for example,
`/state/tariff`). The approval stores that market's candidate journal path.
The live indexer reads newly approved paths on each poll; keep the deployed
`compose.indexer-live-candidates.yml` overlay for older approvals that lack
this field. An approved collector must not publish until the indexer is
healthy and can read its candidate journal.

The apply step writes the registry atomically and is idempotent. It does not
start a collector, buy data, publish observations, provide graduation capital,
or open Pro trading. Those steps require their own chain and budget checks.

## Reference data coverage preflight

`node scripts/reference-coverage-preflight.mjs /absolute/path/index.sqlite`
reads the existing reference observation database without writing to it or
calling a provider. For cumulative YouTube views and X post likes it checks
whether every five-minute bucket in the last 28 days has a reading, the latest
reading is under ten minutes old, and adjacent cumulative values do not fall.
It verifies that each selected reading still matches its stored raw response
SHA-256; YouTube readings must also match the approved video ID and official
provider. Missing buckets, downward revisions, and invalid evidence are
reported separately. Spotify's dated third-party reports are explicitly
outside this five-minute check.

`SOURCE_COVERAGE_COMPLETE` is only a source-data prerequisite. It is **not** a
market approval, an activity formula, an oracle publication, or permission to
offer financial trades. `services/data/cumulative-intervals.mjs` preserves the
exact count change and actual timestamps between adjacent readings; polling
times may drift, so this is not an exact calendar five-minute activity bucket.
It does not reveal minute-by-minute distribution.
Do not fill missing minutes or treat a provider's downward revision as negative
activity. The separate financial formula and correction policy must be fixed
and verified before these reference subjects can become executable markets.

## Finalized Snapshot archive preflight

Before deploying a program binary that adds Snapshot retirement, calculate its
actual Devnet ProgramData extension and temporary upload buffer funding. This
check reads the finalized upgrade authority, binary hash, rent, and payer
balance; it never loads a signer or sends a transaction:

```sh
node scripts/preflight-program-upgrade.mjs \
  /absolute/path/ante_up.so TRUSTED_SBF_SHA256 \
  /absolute/path/devnet-rpc.url DEPLOYER_ADDRESS
```

The result's `peakRequiredLamports` includes a 0.1 SOL fee reserve.
`FUNDED_FOR_ESTIMATE` is a funding preflight, not permission to upgrade or
retire accounts. Re-run it against the exact binary immediately before the
program extension and deployment. Keep the temporary upload buffer, signer
files, and RPC URL outside the public repository.

Before retiring a Snapshot account, rehearse its disappearance from RPC reads
against the trusted archive. The rehearsal fetches the still-live finalized
account, checks its bytes against the archive, hides that one address from an
in-memory RPC wrapper, and requires the complete program scan to recover it.
It neither closes an account nor signs a transaction:

```sh
node scripts/simulate-retired-snapshot-read.mjs \
  /absolute/path/snapshots.sqlite TRUSTED_ARCHIVE_SHA256 \
  /absolute/path/devnet-rpc.url SNAPSHOT_ADDRESS
```

A passing rehearsal does not replace the later finalized retirement and live
indexer readback. The current Snapshot must remain on chain.

`scripts/export-snapshot-archive.mjs` creates a separate, immutable SQLite copy
of every currently indexed Devnet Snapshot account. It compares the finalized
program account, PDA, candidate hash and fields, and finalized indexer event.
The source index remains read only. The output path must not exist.

```sh
node scripts/export-snapshot-archive.mjs --plan SOURCE_INDEX.sqlite OUTPUT_ARCHIVE.sqlite DEVNET_RPC_URL_FILE
node scripts/export-snapshot-archive.mjs --create SOURCE_INDEX.sqlite OUTPUT_ARCHIVE.sqlite DEVNET_RPC_URL_FILE
```

To build a later immutable archive after an older Snapshot account is no longer
on chain, pass the previous archive and its separately recorded SHA-256. The
exporter verifies every previous row, compares any still-live copy byte for
byte, requires the newest Snapshot of each market on chain, and adds new
finalized accounts from the index. It records the parent file hash in the new
manifest. Keep both archive generations and their trusted hashes:

```sh
node scripts/export-snapshot-archive.mjs --plan SOURCE_INDEX.sqlite NEXT_ARCHIVE.sqlite DEVNET_RPC_URL_FILE PRIOR_ARCHIVE.sqlite PRIOR_TRUSTED_SHA256
node scripts/export-snapshot-archive.mjs --create SOURCE_INDEX.sqlite NEXT_ARCHIVE.sqlite DEVNET_RPC_URL_FILE PRIOR_ARCHIVE.sqlite PRIOR_TRUSTED_SHA256
```

The tool verifies the Devnet genesis, requires a complete sequence for each
market, writes atomically, and stores a count and digest in the archive manifest.
Keep the archive inside the encrypted backup scope and verify its SQLite
integrity and offsite recovery before considering any account retirement.
The active backup config must list that exact archive under both `required`
and `immutableSqlite`. The latter preserves the finalized SQLite file byte
for byte; ordinary live SQLite databases still use the WAL-aware backup path.
The immutable file must have no `-wal` or `-shm` sidecar. After the scheduled
backup, compare the PC's isolated restore of this archive against the trusted
source file SHA-256 before using it to authorize retirement. A backup made
before the archive existed, or one that normalized its bytes, does not satisfy
the retirement gate.
Record the archive file's SHA-256 outside the archive, then independently read
back every saved account, candidate and finalized event:

```sh
sha256sum OUTPUT_ARCHIVE.sqlite
node scripts/verify-snapshot-archive.mjs OUTPUT_ARCHIVE.sqlite TRUSTED_SHA256
```

The verifier requires the separately recorded SHA-256 and checks SQLite
integrity, per-account hashes, PDAs, candidate and event agreement, sequence
continuity and the manifest digest. It reads the archive only. A successful
readback does not yet prove that the live indexer can replay after closure.
Creating or rolling an archive does not close onchain accounts or recover rent.
The indexer has an opt-in verified archive read path and a test for a missing
historical account. `retire_snapshot` is staged in source. Bulk retirement
requires a reviewed program upgrade, one controlled Devnet retirement, and a
successful post-closure indexer replay first.

The retirement instruction requires both the configured publisher and admin
signatures. It refuses the newest Snapshot or one younger than seven days and
refunds rent to the publisher. The archive digest argument is an operator
commitment; the program cannot inspect offchain storage. Before a single
retirement, verify an independently retained copy on another host and create
its receipt there:

```sh
node scripts/snapshot-offhost-receipt.mjs OFFHOST_ARCHIVE.sqlite TRUSTED_SHA256 RECEIPT.json
```

On the server, `scripts/retire-snapshot.mjs --plan` checks the primary archive,
the recent off-host receipt, a matching encrypted-backup result and PC copy
receipt, and an isolated restore report that proves the exact archive SHA-256.
It also checks a finalized byte-for-byte account match, the market's latest
sequence, and the configured signers. The restore report must be recent; its
backup SHA-256 is bound into the plan fingerprint. `--execute` also requires
the exact plan fingerprint, both key files, a successful simulation, and a new
attempt journal. It signs at most one account per invocation and never resends
an unknown transaction. `--status` reconciles the signature with the account's
finalized absence. The required `ANTE_UP_RETIRE_*` environment variables are
listed in the script; keep the receipt and journal outside the public checkout.

After the first retirement is finalized, replay the live indexer from the
trusted archive and confirm that its public readback still includes the retired
Snapshot. Only then use `scripts/retire-snapshot-batch.mjs` for bounded repeated
recovery. It uses the same per-account archive, recent backup and off-host
restore checks as the one-account tool. Put each one-account journal in a
private directory under `<SNAPSHOT_ADDRESS>.json`. A previously finalized,
scope-bound journal excludes that archived address from later plans; an
unfinished or malformed journal stops the whole batch. Never remove an
unfinished journal merely to retry a transaction. Reconcile its signature and
account with the one-account `--status` path first.

The batch runner defaults to one account and never signs without both
`--execute` and `ANTE_UP_RETIRE_BATCH_EXECUTE=YES`. Set
`ANTE_UP_RETIRE_JOURNAL_DIR` and the same archive, receipt, backup, RPC and
signer environment variables required by the one-account tool, then run:

```sh
node scripts/retire-snapshot-batch.mjs --plan
node scripts/retire-snapshot-batch.mjs --execute
```

`ANTE_UP_RETIRE_BATCH_LIMIT` is bounded to 1–16. More than one account per
invocation also requires `ANTE_UP_RETIRE_PILOT_VERIFIED=YES`, which the operator
must set only after the finalized first closure and live indexer readback, and
`ANTE_UP_RETIRE_PILOT_ADDRESS` naming that account. The runner checks that its
finalized journal exists and reconfirms its signature and account absence on
Devnet before signing a multi-account batch.
Each result must be finalized before the next account is signed; an unknown or
failed result stops the batch. This source tool is not an enabled production
schedule. Renewal of the recent backup and off-host receipt, real Devnet
pilot, bounded scheduling and monitoring remain separate deployment steps.
