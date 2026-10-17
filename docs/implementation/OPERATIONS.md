# Operational backup, recovery drills and alerts

Implementation scope: October 16, 2026, based on `471b69a`. These tools are
available for review. No production backup, off-host copy, recovery, deployment
or notification has been executed as part of their implementation.

Use Node 24+. The scripts use only Node builtins, including `node:sqlite`.
`deploy/Dockerfile.ops` is a separate small image; it does not rebuild the app or
change collector/evidence configuration. No provider charges, signatures,
transaction submissions, faucet grants or automatic replenishment occur here.

## What must be recoverable

Back up the **entire** configured state tree, not just the three known SQLite
databases. This includes collection budgets and observations, hidden `.history`
blobs, candidate/publication state, raw provider responses, evidence jobs,
payloads/manifests, signed `.item` uploads and receipts, chain-submission journals,
worker retries, current projections/cursors, price history, visitor SOL grants,
registration/operations/profile tables and any optional keeper scope/attempts.
Terminal or uncertain states must survive unchanged. Never reset a budget,
pending send, grant ledger or issue receipt to make a restored worker start.

The encrypted package also contains separate `secrets` and `deployment` roots.
Inventory **all actual bind mounts**, including files mounted from outside
`ANTE_UP_SECRET_DIR` (for example a keeper signer). Add a separate named root and
required paths when necessary. Directory symlinks, file symlinks, hard links and
special files are rejected. Provision actual files in reviewed directories.

Prepare a private recovery-config directory containing the exact Compose file
set, `compose.resolved.yml`, `release.env`, and `image-inventory.json`. Capture
these before maintenance, using the operator's existing Compose invocation:

```sh
# `dc` below means the EXISTING docker compose command with its --env-file,
# project name, and ALL active -f overlays. Do not substitute compose.yml alone.
umask 077
dc config > "$ANTE_UP_RECOVERY_CONFIG_DIR/compose.resolved.yml"
dc images --format json > "$ANTE_UP_RECOVERY_CONFIG_DIR/image-inventory.json"
```

The directory must be private: rendered Compose/env files may contain secrets.
Copy the actual active env file to `release.env` without printing it. Record
deployed image IDs/digests, source SHAs, UID/GID, mount paths, network/ingress/TLS
setup and external RPC/Turbo/SAS identifiers. If images exist only locally,
export them separately to encrypted off-host storage or verify a retained private
registry copy. This package does not contain Docker images, host OS, ingress
certificates outside configured roots, or an independent copy of chain/Arweave.
An app commit alone cannot recreate the differing historical service images.

## First-time configuration

1. Copy `deploy/ops/backup.example.json` and `monitor.example.json` to a private
   `ANTE_UP_OPS_CONFIG_DIR` as `backup.json` and `monitor.json`. Adapt required
   files to the real mount inventory. Do not remove a missing requirement just
   to pass; establish whether the service is enabled and where its state lives.
2. Set backup `release` to reviewed source/image identities. Replace monitor
   placeholders with public addresses and the **approved collected** market PDA.
   Do not add no-data/reference markets to the collection freshness allowlist.
3. Confirm X reservation ceilings against `runRegularPoll`'s current defaults
   (daily 10,000,000 / total 100,000,000 micros) and the actual
   `collection-config.json.estimatedCostMicros`. The example's 1,000 micros is
   only a placeholder estimate. Initial archive reservations count against total
   but do not use the regular daily ledger. These are conservative local
   estimates, not the provider's invoice or account credit balance.
4. Confirm evidence limits against the running container: the recorded October
   16 limits were daily 60,000,000,000 and total 100,000,000,000 winc. The observer
   does not change them. Reservations, accepted uploads and current Turbo
   credits are different measurements; Turbo credit balance is not queried.
5. Choose publisher, proof fee-payer, visitor SOL and optional keeper public
   addresses and useful low-balance thresholds. The example visitor threshold
   is the 0.1 SOL reserve plus one 0.02 SOL grant. 0.01 SOL for publisher/payer
   is a floor to review against actual rent and fee consumption, not runway.
6. Provision a separate observer runtime directory, backup output directory and
   backup-report directory, writable by the configured UID/GID. All source/config
   mounts are read-only. `create_host_path: false` prevents typo paths from
   silently becoming empty directories. Both Compose profiles require all
   interpolation variables even when starting one service; validate `dc config`.
7. Generate a **new** 32-byte random backup key outside all captured roots. Use
   a private key file and independent secure escrow. Never reuse a wallet key or
   put the recovery key into the archive, repository, logs or public env inputs.
   Loss of this key means loss of the encrypted backup. Example, with an absent
   destination and a precreated private parent directory:

   ```sh
   node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync(process.argv[1],randomBytes(32),{flag:"wx",mode:0o600});' "$ANTE_UP_BACKUP_KEY_FILE"
   ```

The custom `.aub` format is versioned: `ANTEUPB1`, 12-byte random IV,
AES-256-GCM ciphertext, 16-byte authentication tag. The prefix is authenticated
as AAD. The encrypted payload contains a length-prefixed manifest and streamed
file bytes. Each manifest entry has a SHA-256, size and optional SQLite schema /
row-count summary. File names, keys and state contents remain encrypted. This
is a local operational format, not a standard archival interchange format;
retain the reviewed tool source and Node runtime with the recovery instructions.

## Backup maintenance window

The JSON journals and databases do not share a transaction. `--quiesced` is an
explicit operator assertion, **not detection that writers stopped**. File-set,
size, inode and mtime checks reject observed source changes, but cannot replace
quiescence. This tool never stops or restarts containers itself.

1. Build/review the ops image first. Prevent concurrent deployment, scheduled
   collection, evidence jobs and host scripts for the whole window. Record the
   exact services running before maintenance; maintenance is externally visible.
2. Stop all writers of the state tree, including `api` (auth/operation/grant/note
   writes), `collector`, `indexer`, `evidence`, `price-history`, optional `keeper`
   and any one-shot tools. Use the full active Compose stack. Stop ingress/web
   or serve maintenance content if needed. Stop the ops observer during this
   window so expected freshness alarms do not masquerade as a new incident.
3. Inspect running containers' mounts and host processes; confirm no writer is
   left and no restart/deploy automation can restart them. Do not use only an
   old heartbeat or a `flock` file's existence as evidence of quiescence.
4. Add `deploy/compose.ops.yml` to the same stack. Create a **new** artifact name:

   ```sh
   dc --profile maintenance run --rm --no-deps ops-backup create \
     --config /ops-config/backup.json --key-file /run/secrets/backup.key \
     --output /backup-output/ante-up-YYYYMMDDTHHMMSSZ.aub --quiesced
   ```

   SQLite main files plus WAL are cloned into private scratch, then the SQLite
   backup API creates standalone databases with DELETE journal mode. Scratch is
   writable; production mounts are read-only. `quick_check`, schema hashes and
   per-table counts are recorded. Database sidecars are omitted only when the
   corresponding main file is recognized as SQLite. All other files, including
   hidden history blobs and receipts, are copied. History references and gzip
   content-addressed hashes are verified. Missing requirements fail closed.
5. On success, record the returned hash, release, counts and timestamp. Source
   state and secrets are untouched. Never overwrite earlier backup files.
   Plain scratch exists under the private output parent during creation and is
   removed on normal success/failure. A killed process or host crash can leave
   `.ante-backup-*` scratch or an incomplete `.aub`; treat these as sensitive,
   verify ownership before cleanup and never regard a filename as success.
6. Restart **only** the services that were running before the window, using
   their existing configuration. Do not enable keeper, expand allowlists,
   rerun bootstrap or increase budgets. Check health and actual data/snapshot
   progress after restart. A failed backup still needs this manual resumption.

Budget for source + plaintext snapshot + ciphertext, and on a drill machine
roughly ciphertext + decrypted stream + extracted files. Large jobs/journals can
make maintenance slow. No pruning or automatic retention deletion is provided.

## Off-host copy and isolated restore drill

Choose a **physically independent** host/object-store mount with encryption,
access control and retention. A second directory, disk partition or Docker
volume on the same server does not satisfy off-host recovery. No target has
been provisioned here. The filesystem interface works with operator-mounted
NFS/SSHFS/removable storage; provision and verify that mount independently.

Run the following on a trusted host with the copied encrypted artifact and
reviewed tool source (not in an application container with active signers):

```sh
node scripts/ops/backup.mjs copy \
  --input /private/backups/ante-up-YYYYMMDDTHHMMSSZ.aub \
  --destination /mounted-independent-backup/ante-up \
  --destination-id reviewed-off-host-store --failure-domain independent-host-name

node scripts/ops/backup.mjs drill \
  --input /mounted-independent-backup/ante-up/ante-up-YYYYMMDDTHHMMSSZ.aub \
  --key-file /private/escrow/recovery.key \
  --target /isolated/ante-up-drill-YYYYMMDDTHHMMSSZ
```

`copy` requires an encrypted-format prefix, creates files exclusively, fsyncs,
reads the destination back, compares SHA-256 and writes an exclusive
`<artifact>.receipt.json`. Destination identity / failure domain are **operator
declarations**. `physicalSeparationVerified: false` intentionally remains false;
the script cannot prove a mount is on another host. Record the operator's
independent mount/host verification separately. Keep at least one prior known
good copy until retention has been reviewed.

`drill` requires a nonexistent target and authenticates the entire ciphertext
before parsing any manifest paths. It rejects traversal, duplicate/case-colliding
paths and unexpected extra bytes, checks every file hash, SQLite quick checks,
schema/row counts and history references. It retains a private extracted
`state/`, `secrets/`, `deployment/` and `restore-report.json` only on success.
On failure it removes only the fresh target it created; existing targets are
never overwritten or removed. Interrupted drills can leave sensitive partial
targets; use a new target and inspect before manual cleanup.

This is an **offline data recovery check**. It does not start services or prove
Docker image availability, key validity, current balances, provider access,
chain reconciliation, Arweave inclusion, SAS readiness or end-to-end recovery.
Do not start collector/evidence/faucet/keeper from a drill while originals run:
the same keys and stale state could repeat paid calls or irreversible sends.

For real disaster recovery, first fence the old host and all writers. On an
isolated replacement validate image/config identity, permissions and cluster;
reconcile uncertain publication/chain submissions, upload receipts, proof IDs,
visitor grants and ledger reservations against finalized external state before
enabling any signer. Enable read-only API/index inspection first. Review each
writer separately. Do not run this procedure as an experiment on the live host.

## Observation and notification contract

`node scripts/ops/monitor.mjs --config /private/monitor.json --check` performs a
read-only pass and prints JSON. Exit 0 = no findings, 2 = findings, 1 = failed
configuration/execution. Normal one-shot/follow mode writes only its separate
runtime directory; an `ALERTING` report is still a successful observer pass.

| Signal | Source and behavior |
| --- | --- |
| Collection delay | `collection.json` last successful poll per approved market, 900s example |
| On-chain posting stopped | Finalized indexed snapshot `dataThrough`, and nonfinal publication candidate `computedAt`; catches an alive worker stuck in PUBLISHING |
| Service failure | Independent indexer/collector/evidence/price heartbeats; missing, stale and future/invalid timestamps alert |
| API / web | Bounded HTTP GET; API must return `mode: devnet`; no wallet/user mutation |
| Proof backlog | All finalized CLOSED_RESULT/CLOSED_NA records without `proofId`, including outside the worker allowlist; count threshold, oldest age per record and worker held count |
| Wallets | Genesis-hash check followed by **finalized getBalance** on public addresses; no private key mounts |
| X / evidence budget | UTC daily/total reservation warning (80%) and exhausted/next-X-request limit; exact BigInt winc arithmetic |
| Storage | Available filesystem bytes versus explicit floor |
| Recovery copies | Destination-readback receipt age and identity plus matching artifact SHA in a recent isolated drill report; does not prove physical separation |

The observer does not parse the very large evidence payload journal every
minute. Finalized obligations and evidence heartbeat supply progress/failure
signals. Snapshot freshness is from the finalized **local index**, not an
independent chain-state auditor; indexer heartbeat and RPC/API checks complement
it. A fresh snapshot does not establish source truth or financial readiness.
Missing inputs and failed RPC checks remain alerts, not zeros or success.

Start `ops-monitor` explicitly with profile `ops` and `--no-deps`, after editing
the example and checking `dc config`. It mounts `/state` read-only and only the
RPC URL, not publisher, Turbo, issuer or faucet keys. The default command never
sends alerts. `report.json` and `health.json` are in the separate observer runtime.
The healthcheck measures observer progress, not whether all services are healthy.

For a dedicated Ante Up Telegram chat, create a separate bot and have the chat
send `/start` to it. Store its token and numeric chat ID in separate files with
restricted permissions. Set `telegramTokenFile` to
`/run/secrets/ops-telegram.token` and `telegramChatIdFile` to
`/run/secrets/ops-telegram.chat-id` in a private copy of the monitor config
named `monitor.telegram.json`; preserve the original `monitor.json` for rollback.
After the user sends `/start`, `node scripts/ops/telegram-chat.mjs
/private/ops-telegram.token` prints the single private chat ID, without printing
the token. Fail on zero or multiple private `/start` chats rather than guessing.
Store that ID in the separate chat ID file. Set
`ANTE_UP_OPS_TELEGRAM_TOKEN_FILE` and `ANTE_UP_OPS_TELEGRAM_CHAT_ID_FILE` to the
corresponding host file paths, then add `compose.ops-telegram.yml` on top of
`compose.ops.yml`. Check the merged Compose configuration before starting only
`ops-monitor` with `--no-deps`. It sends a short alert, repeats unresolved
findings at `repeatSeconds`, and sends a recovery message. A failed Telegram
response is retried without advancing acknowledgement. Neither the bot token
nor Telegram's response body is written to the monitor report or logs. The
monitor mounts no signing keys. This chat alert does not detect a total host or
network outage; that requires an independent deadman service.

Alternatively, provision a reviewed HTTPS receiver and add
`compose.ops-alerts.yml`. It adds `--deliver` and private URL-file mounts. The
generic receiver accepts JSON:

```json
{"version":1,"monitorId":"ante-up-devnet","at":"...",
 "firing":[{"id":"WALLET_LOW:publisher","code":"WALLET_LOW",
             "scope":"publisher","severity":"critical",
             "metrics":{"lamports":"1","minLamports":"10000000"}}],
 "resolved":[{"id":"SERVICE_STALE:indexer","code":"SERVICE_STALE","scope":"indexer"}]}
```

Stable IDs deduplicate notifications. New alerts / severity changes send once;
unresolved alerts repeat at `repeatSeconds` (3600 example), recovery sends a
resolved event. Acknowledged deliveries persist atomically. Non-2xx/timeout
does not acknowledge: the next cycle retries. A crash after receiver acceptance
but before local acknowledgement may duplicate delivery; receivers should
deduplicate on monitorId, at and alert ID. Dry observation never suppresses the
first real notification. Provider URLs/bodies and exception details are not
printed. The generic JSON webhook and the Telegram adapter are mutually
exclusive in `monitor.json`. Reports contain public market/record identifiers;
scope receiver or chat access.

An optional independent deadman receives `{version, monitorId, at, status}` each
successful `--deliver` cycle. It must alert when updates stop. A local container
cannot report total host/network/power loss itself. The alerts overlay requires
both URL files; remove the deadman config/mount intentionally for an initial
receiver-only trial, while leaving the missing independent host-loss monitor as
an open operational dependency.

After a successful real copy and drill, atomically publish that exact receipt
and report as the configured `latest-copy.json` / `latest-drill.json` in the
private report directory. A newer copy without a matching drill is a finding.
Never manufacture a fresh timestamp around an old artifact. Scheduling is an
operator handoff: suggested starting objectives are daily backups with a 48h
freshness alarm and a drill of each new artifact; actual RPO/RTO and maintenance
duration have not been measured or agreed.

## Integration handoff

The integration owner must review/build this ops image, validate the Compose
merge on Linux, fill addresses/budgets/mount inventory, choose and verify an
off-host failure domain, escrow the key, and configure the actual notification
receiver plus independent deadman. Then schedule a maintenance window, create
the first encrypted complete snapshot, read back the actual remote copy, run
the offline drill on a separate trusted machine, publish its matching reports,
and trial firing/recovery with the selected receiver. No production-ready or
disaster-recovery-complete status is implied until these have evidence.

No Hermes Task or Calendar connector is configured for this implementation;
the above actions are an explicit handoff, not a duplicate authoritative task
list. No vault HOME, existing server backup, source state or secret was edited.

Local checks:

```sh
node --test scripts/ops/backup.test.mjs scripts/ops/monitor.test.mjs
git diff --check
```

Tests cover WAL recovery, secret/config inclusion, encryption, wrong keys,
tamper/truncation, exclusive destinations, symlink rejection when permitted,
history integrity, stale/invalid/missing state, uncertain publication and X
requests, proof obligations, BigInt budgets, Devnet RPC boundaries and
notification acknowledgement/retry/recovery. Synthetic fixtures are not a live
backup, physical off-host verification or production alert delivery test.

Implementation verification on October 16: Node v24.15.0 on Windows completed
13 tests, 13 passed, zero skipped, including a real temporary loopback HTTP
receiver and junction rejection. The default sandbox blocked loopback and
junction creation; the successful run used approved local test access. Docker
and WSL were unavailable, so image build, Linux directory fsync and the actual
Compose merge/runtime remain unverified. No live server connection was used.
