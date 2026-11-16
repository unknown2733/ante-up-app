# Collection history cold storage

Collection state uses immutable, content-addressed gzip histories. The hot reader
still uses `<collection>/.history/<content-hash>.json.gz`. Set both
`ANTE_UP_HISTORY_STATE_ROOT` and `ANTE_UP_HISTORY_ARCHIVE_ROOT` to enable a cold
fallback under `<archive>/<relative state-file directory>/<content-hash>.json.gz`.
Use a shared archive below the state root, outside the individual collection
directories, so the full state backup includes it. These are server inputs, never
browser environment variables. All collection, evidence and Keeper processes
which read collection state need the same settings.

A missing hot blob may use the archive; a corrupt hot blob never silently falls
back. Both forms verify the original decompressed content hash. Existing JSON
references and gzip bytes are not rewritten. A resumed writer creates new active
histories normally. Cold histories are retained; this is not a deletion policy.

## Migration

Pause writers to the affected collection, candidate, proof and Keeper journals.
The `--quiesced` flag asserts this operator precondition; it does not stop services.
Root hashes and the root file set must remain unchanged until pruning finishes.
Use absolute local paths, and keep the migration plan outside collection roots.

```sh
node scripts/archive-state-history.mjs --plan "$STATE_ROOT" "$ARCHIVE_ROOT" "$PLAN_FILE" solana tariff
node scripts/archive-state-history.mjs --stage "$PLAN_FILE" --quiesced
node scripts/archive-state-history.mjs --verify "$ARCHIVE_ROOT"
```

The collection names are exact existing directory names, not market identifiers.
The plan keeps current collection references, jobs without both `FINALIZED` and
finalized publication evidence, and references in the evidence and Keeper roots
active. Historical journal copies are verified but do not create new obligations.
Unknown obligation states stay active. All nested references are checked without
materializing every historical replay in memory.

Staging copies exact blob bytes and publishes `manifest.json` with version 1,
kind `HISTORY_ARCHIVE_INVENTORY`, and entries containing relative `path`, compressed
`sha256`, original `contentHash`, and `bytes`. It does not remove hot copies.

Before pruning, include `state/history-archive/manifest.json` in the backup's
required files and perform an isolated restore. Use the restore report's
`historyArchive` receipt, containing kind `HISTORY_ARCHIVE_RESTORE_VERIFICATION`,
the exact `manifestSha256`, and `hashes: "matched"`. A routine stage or verify result
is intentionally not accepted as a restore receipt.

```sh
node scripts/archive-state-history.mjs --prune "$PLAN_FILE" "$RESTORE_RECEIPT" --quiesced
```

Pruning removes only active duplicate files listed in the plan, after archive,
receipt, original bytes and all reference checks. Interrupted staging and pruning
can resume with the same unchanged roots and plan. If a root changes, stop and
create a new plan; do not alter hashes or forge a receipt to force progress.
Readers must be deployed with cold fallback before pruning. An old reader that
does not support cold fallback is not a valid rollback after pruning; first copy
the verified archived blobs back to their original active locations.

## Accounting

`measureStateStorage` reports active, archived, total and host-free bytes. It
excludes only inventory-listed, size-matching cold blobs and the inventory file
from active admission usage. Unlisted files remain active. Missing inventory
entries, changed sizes and unsupported filesystem entries fail closed. Content
hash integrity is checked during migration, isolated restore and each read;
routine accounting avoids rehashing the entire archive on every health poll.
Global monitoring must report both active and archived usage and retain the host
free-space guard. No quota or provider budget is raised by this migration.
