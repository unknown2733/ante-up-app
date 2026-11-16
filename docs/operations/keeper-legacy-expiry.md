# Legacy unsigned LP recovery

This operator tool does not sign or submit transactions. Its default is a read-only plan. It is scoped to the existing tariff cycle 4 journal and only an unsigned `UNKNOWN / RECOVER_LP_WINDOW` reservation. It does not automatically run on a timer.

The current Keeper stores its signature durably before broadcasting, but an old reservation without that signature is not treated as proof of no broadcast. An unchanged account and elapsed wall time alone are insufficient.

## Required evidence

1. The deployed Keeper transport for the original attempt used the reviewed recent-blockhash path: `KitKeeperInstructionTransport.send` → `prepareUnsignedTransaction` → `submitAndConfirmFinalized`. No durable nonce, alternative signer, or transaction sender may have been used. The execute flag explicitly acknowledges this operator code/deployment review; it is not inferred from the missing signature.
2. Run through the Python guard launcher. It acquires the existing host backup and weekly Keeper locks without deleting or truncating them, then execs Node with those descriptors. Node verifies lock owner PID, inode and exact path. Running weekly/manual Keeper processes or containers cause a stop.
3. All other configured live Keeper journals for this market must have no unresolved attempt. The exact target reservation, generation, fingerprint and timestamp must remain unchanged.
4. Read finalized market and finance accounts, validate owner/discriminator and reconstruct the original fingerprint. Any changed cycle, maturity, generation or last-LP week blocks recovery. Never guess the original values from the hash.
5. Capture a processed blockhash whose block time is after quiescence; read a specific finalized block and require its block height beyond the boundary's last valid height plus finalized blockhash invalidity. Read the same accounts at or after that finalized block's slot (not merely the earlier boundary slot), recheck their fingerprint, then recheck producers and locks.
6. In one SQLite transaction append the original attempt and proof to `keeper_expiry_receipts`, then mark only that reservation `FAILED`. A failed guard, duplicate receipt, another unresolved attempt, modified row, RPC error or SQL failure rolls back. Normal Keeper replanning is separate and can sign only after the operator releases the locks.

The proof relies on the reviewed program semantics: `start_lp_window` clears nonzero maturity or changes the last LP week / validity generation; opening another Pro cycle increments the cycle. Therefore an unchanged original fingerprint cannot represent a successfully applied LP action followed by reopening. A program upgrade changing these semantics invalidates this recovery procedure until reviewed again.

## Operator invocation

Build/bundle `scripts/recover-keeper-lp-quiescent.mjs` for the existing Node 24 host runtime, retaining `node:*` built-ins including `node:sqlite`. No keypair file is needed. Use existing RPC URL files; never put their contents in command arguments.

First run Node CLI without `--execute`, with `--attempts`, `--rpc-file`, optional `--backup-rpc-file` and a new `--output` directory. After reviewing the plan and original deployed transport, run:

```sh
python3 scripts/recover-keeper-lp-guard.py /path/to/node /path/to/recover-keeper-lp-quiescent.mjs \
  --attempts /srv/ante-up/builds/service-state/keeper-auto/tariff/cycle-4/keeper-attempts.sqlite \
  --rpc-file /srv/ante-up/secrets/devnet-rpc.url \
  --backup-rpc-file /srv/ante-up/secrets/devnet-rpc.secondary.url \
  --output /path/to/new/operator-recovery-directory \
  --execute --reviewed-recent-blockhash-only
```

Do not invoke inside another process already holding the two locks: the launcher intentionally exits `KEEPER_EXPIRY_LOCK_BUSY`. It never restarts services or removes lock files. Keep the external receipt and the SQLite audit receipt. This is not an authorization to reopen LP, settle positions, or modify another attempt.

Local tests: `node --test services/keeper/test/legacy-lp-expiry.test.mjs`. These use only in-memory SQLite and injected RPC/guard fixtures; no source API, chain transaction or wallet is used.
