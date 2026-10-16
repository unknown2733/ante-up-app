# Proof intake and cost guard handoff — 2026-10-16

Branch `work/proof-20261016`, base `471b69ae57fcc2e592b47b139770da025ec385cd`.
Implementation commit: `2c79cecababd6733147d8177c6881325360756de`.
Deployment-safety follow-up: this branch restores the default approved-record allowlist and adds an explicit auto-discovery overlay.
No push, merge, server deployment, upload or SAS transaction was made from this worktree.

## Live status boundary

The public `https://ante-up.fun/api/v1/records/<id>` requests for the four previously pending records all failed with `HttpRequestException` from this execution environment. The web retrieval tool also could not reach them. Therefore the latest reported **5 ISSUED / 4 pending** is a handoff premise, not a fresh verification. No current Arweave 20-confirmation, SAS, protocol completion, or public `proofId` success is claimed.

Read-only server reconciliation, using the new image and an existing state mount:

```sh
IMAGE=<new image built from this commit>
STATE_DIR=/srv/ante-up/builds/service-state
RPC_FILE=<existing Devnet RPC URL file>
IDS='8YFtrhxJMMQwjKY8JXLfF9HonjaQHCFWUHtSvMw4BSoP 74S8WVFD8ypLcGPd9ydR3B8gvte6SFtZP73GPSpnYCUb 9tak3tGabXLeK5W7QQCCNv1CdN66qoayWFLBmc6CGhxv 7hz4GJhPVFqv38NWN7yhiz2afKCBiJ1D1xuJy4bjyp7g'
docker run --rm --read-only -v "$STATE_DIR:/state:ro" \
  -e ANTE_UP_LIVE_DIRECTORY=/state/live-smoke "$IMAGE" \
  node scripts/report-proof-backlog.mjs $IDS
for id in $IDS; do
  docker run --rm --read-only --tmpfs /tmp -v "$STATE_DIR:/state:ro" \
    -e ANTE_UP_LIVE_DIRECTORY=/state/live-smoke -e ANTE_UP_RECORD_ID="$id" \
    "$IMAGE" node scripts/verify-arweave-proof.mjs
  docker run --rm --read-only --tmpfs /tmp -v "$STATE_DIR:/state:ro" \
    -v "$RPC_FILE:/run/secrets/rpc.url:ro" \
    -e ANTE_UP_LIVE_DIRECTORY=/state/live-smoke -e ANTE_UP_RECORD_ID="$id" \
    -e ANTE_UP_RPC_URL_FILE=/run/secrets/rpc.url \
    -e ANTE_UP_PUBLIC_API_URL=https://ante-up.fun/api \
    "$IMAGE" node scripts/verify-devnet-proof.mjs
done
```

`report-proof-backlog` compares local job/confirmation/completion with the public record and proof API. `verify-arweave-proof` independently rechecks the saved receipt signatures, parent transaction signature/root, ANS-104 inclusion, exact content and **every artifact plus manifest at >=20 confirmations**. It reports a pending/error before that threshold. `verify-devnet-proof` uses read-only SQLite, finalized Devnet RPC and the deployed public API to compare SAS claims, protocol hash and public `proofId`; only `VERIFIED_FINALIZED` is complete. These checks use no upload, issuer or payer key.

## Integration

Cherry-pick the implementation and deployment-safety follow-up commits only after reviewing them against the current integrated tree. `deploy/compose.evidence.yml` retains the existing approved-record allowlist as the default. After live admin signer, budget, storage and RPC guard checks, explicitly append `deploy/compose.evidence-auto.yml` **after** `compose.evidence.yml` in the Compose file list to opt into `ANTE_UP_EVIDENCE_AUTO_DISCOVER=yes`. The overlay sets `ANTE_UP_EVIDENCE_RECORD_IDS` to the empty string; the worker rejects a nonempty allowlist combined with auto-discovery as `EVIDENCE_SCOPE_CONFLICT`. Compose still interpolates the base file's required allowlist variable before merging, so keep the approved ID setting in the operator env even when the overlay is selected. Confirm the effective evidence environment has auto-discovery `yes` and an empty record ID value before recreating only the evidence service. Without the overlay, the existing allowlist remains the only scope.

The existing 15B winc per-record, 60B UTC-day and currently approved 100B cumulative cap must be supplied unchanged through the operator budget env. Do not reset `budget.json`, `jobs.json`, `receipts/`, signed-item files, `worker.json`, `chain-submissions/` or the new `admission-close.json`/`intake.json` on restart. Keep one `flock` worker. The old image tag in Compose must be replaced with the new reviewed image by the integration owner; this branch does not deploy it.

In auto-discovery mode, the worker inventories all finalized closed results in `evidence/intake.json` before applying retry scheduling. It processes finalized records without a hardcoded record allowlist, still ordered by exit time and bounded by batch size. In default mode it retains the approved allowlist. Existing job IDs/version checks, signed-item reuse, cached receipts, deterministic SAS PDA and uncertain submission journals remain in effect. A budget failure leaves the accepted record in the inventory and retry queue; it never deletes or silently marks it complete.

Before each auto-discovery pass, `evidence-admission-gate.mjs` reads the finalized on-chain outstanding count, saved upload reservations, actual Turbo balance and storage pressure. It reserves the configured record cap for **all outstanding duties plus one possible new chip**. If total/day/balance or 80% state-storage headroom is insufficient, it sends a **close-only** admission instruction using the already mounted payer key, after verifying that key is the finalized program admin. It saves the signed wire before its one send and never automatically resends an uncertain transaction; an unresolved close marks evidence health `UNSAFE` while already accepted proof work continues. **A failed or unavailable guard does not prove the on-chain admission gate closed.** New opens may remain possible until an operator verifies on-chain state and closes or reconciles the gate. The worker never automatically reopens admission. The operator must reconcile an uncertain gate signature and explicitly review any reopening.

Turbo's actual signed item byte count is now reported in preflight; transport quotes the bytes it really sends and durably enforces record, daily and total winc caps. Shared signed-item retries add no new reservation. The preflight manifest remains a 16KB allowance; the transport checks the actual signed manifest quote before sending. Historical reservations in the existing ledger have no per-record attribution, so the new `byRecord` field tracks additional spend from this release onward while existing total/day entries remain authoritative. If approved funds already fall short of accepted duties, the worker preserves them and reports budget errors; it does not increase limits or issue a duplicate request.

## Verification and remaining gates

Live readiness follow-up: the October 16 server readback found four records with
public `proofId` and `ISSUED` SAS status while their durable completion journals
still said `SUBMITTED`. The worker now schedules a linked original proof again
until its completion journal reaches `FINALIZED`; the existing runtime first
reads the finalized on-chain proof hash and updates the journal without sending
another completion transaction. Verify all four with
`scripts/verify-devnet-proof.mjs` after deploying the reviewed worker, before
enabling automatic intake.

- Evidence module: `npm test` **37/37 passed** on Node 24 after the deployment-safety follow-up in the original worktree; the linked-journal integration follow-up passed **38/38** in the merged checkout. The copied local dependencies matched direct module versions; no manifest/lockfile changed. Tests cover default allowlist, opt-in auto scope, conflict rejection, Compose overlay values and linked-journal reconciliation. The live Compose merge still needs server readback before activation.
- `node --check` for the worker, gate, proof scripts and `git diff --check`: passed. The gate executable without runtime inputs failed closed at `MISSING_ANTE_UP_LIVE_DIRECTORY`.
- No live server state, Linux image build, on-chain gate transaction, actual new close, upload, 20-confirmation result, SAS issue or public link was tested here. Root must check admin-key identity, Compose env caps and one-worker lock before deployment. A gate transaction with ambiguous send remains operator reconciliation work. Storage or host exhaustion beyond the hard limit can still stop accepted work until capacity is restored.
