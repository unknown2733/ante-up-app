# Recovery coverage and freshness

The encrypted archive's manifest lists files that were mandatory when it was
created. `drill` authenticates the archive, checks every file hash and SQLite
inventory, and checks that all declared mandatory files were restored. A newer
recovery contract can require files an older archive did not contain.

Prepare an operator-owned JSON array of archive-relative paths, using
`restore-required.example.json` as a starting point, and run:

```sh
node scripts/ops/backup.mjs drill --input /offhost/backup.aub --key-file /private/backup.key --target /offhost/new-isolated-drill --requirements-file /private/restore-required.json
```

The target must not exist. No service is started and no signer is opened. The
required paths must be explicitly declared by the archive and actually restored.
The report includes `backupCreatedAt` from the authenticated manifest and
`requiredFiles` after file verification. File contents and individual file hashes
are not added to the report. The report is local operational evidence, not a
cryptographic attestation of the PC or its physical separation.

The Keeper recovery bundle needs the active runner, its actual cron entry,
market configuration, required RPC files and signer files. The examples list
the primary RPC and publisher key in the general backup contract, and the
Keeper-specific inputs in the additional restore contract. Keep all private
inputs outside this repository. Verify that the cron's selected image ID is in
the saved image inventory; saving the cron alone does not save that image.
The current image must also be included when Keeper uses a different image from
long-running services. Archive collection/backup locks and timer definitions
belong to the host recovery bundle as well.

## Rollout order

1. Preserve existing tools/configs. Install the reviewed backup tool on the
   server and PC first. The archive format is unchanged. Without a requirements
   file, older archives remain readable and new reports gain the two fields.
2. Add the required paths to the server backup configuration and verify the
   prepared runner and cron against the active files, the image inventory,
   market config and private-file presence without printing their contents.
   Preparation does not establish a successful scheduled backup.
3. Give the PC its reviewed requirements JSON and append `--requirements-file`
   to the existing drill invocation. Keep the schedule unchanged. An old archive
   missing this contract will fail closed; do not overwrite old success reports
   or treat the failure as proof of a new backup.
4. After the next natural server backup and PC copy/drill, match artifact name,
   SHA-256, byte count, original creation time, required paths, and any separate
   immutable Snapshot receipt. Preserve `physicalSeparationVerified=false` unless
   physical separation was independently established.
5. Deploy the reviewed monitor with `backup.requiredFiles` set to the same
   reviewed array. Check without delivery first. Missing legacy fields produce
   `RESTORE_REQUIREMENTS_MISSING` / `INPUT_INVALID:backup-created-at`; a freshly
   copied old artifact produces `BACKUP_ARTIFACT_STALE`. Existing receipt/drill
   hash, destination and verification-age checks still apply. Only then enable
   ordinary delivery. Test messages require separate operator authorization.

## Rollback

Preserve all archives, reports and private material. Restore the prior monitor
image and config together, then the prior PC command/tool and server tool/config
if needed. Remove the new CLI flag before reverting to a tool that cannot parse
it. Older tools can read archives produced by the new tool. Rolling back the
coverage gate removes assurance about the new required inputs; it does not
prove they were backed up. Do not change timers, start recovered services or
enable Keeper signing as part of an isolated drill.
