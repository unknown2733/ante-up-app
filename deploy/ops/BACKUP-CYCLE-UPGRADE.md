# Backup cycle upgrade

The new host supervisor records independent `creation`, `serviceRecovery`,
`artifactVerification`, and `publicReadback` phases. A successful copy/restore does
not resolve a service restart failure. Results are written atomically to
`ops-reports/latest-cycle.json` and a timestamped report; stdout contains only
phase states. Recovery waits up to 180 seconds, with five-second intervals.

Deployment is an operator action, not part of running tests:

1. Build the reviewed ops image and update both server backup and PC drill code.
   Install `backup-cycle.mjs` and `common.mjs` together on the host with Node 24+.
2. Run `prepare-cycle-upgrade.mjs --base <existing-backup-directory> --output
   <separate-staging-directory> --supervisor <absolute-path>/backup-cycle.mjs`.
   It refuses unknown wrapper tails and writes replacements only. Review the diff
   and `bash -n` both files before replacing the existing wrappers. Retain prior
   versions. The existing generation script's writer locks and EXIT restoration
   are unchanged; immediate post-start checks move to the supervisor.
3. Include the supervisor and common module in deployment recovery inputs and the
   required-file contract, preserving every existing required file. Update image
   references in the host backup runner and its recovery image inventory together.
4. The history archive is under the existing `state` root at
   `history-archive/manifest.json`; require that manifest once staging is complete.
   Backup/drill validate inventory, compressed hashes, decompressed content hashes,
   and nested active/cold references. The isolated drill report's `historyArchive`
   object is the `HISTORY_ARCHIVE_RESTORE_VERIFICATION` receipt for pruning active
   duplicates. A source-only verification does not authorize pruning.
5. Set monitor `historyArchiveDirectory` to `history-archive` only after its
   manifest is present. The monitor reports total, archived and active-state bytes;
   an invalid inventory remains counted in active storage and raises an alert.
   Set `backup.cycleReport` to the mounted `latest-cycle.json`. Do not replace
   existing required-file, copy receipt or drill checks.
6. Verify the next natural server schedule and matching PC copy/drill. Keep manual
   test results distinct from scheduled execution. Do not enable a successful
   restore label when any required phase has failed or remains unknown.

Rollback requires keeping archive-aware readers while any active history blobs
exist only in the archive. Restoring an old reader requires first restoring those
exact blobs to their original active paths and checking every reference.
