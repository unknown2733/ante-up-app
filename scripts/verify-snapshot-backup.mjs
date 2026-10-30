/** Bind retirement to a recent encrypted backup that was copied and restored off-host. */
import { basename } from 'node:path';

const hex = /^[0-9a-f]{64}$/;
const check = (condition, code) => { if (!condition) throw new Error(code); };
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;

export function verifySnapshotBackup({ backup, copy, drill, archiveSha256, archivePath,
  now = Date.now() }) {
  const archiveName = basename(archivePath ?? '');
  const createdAt = time(backup?.createdAt);
  const copiedAt = time(copy?.verifiedAt);
  const restoredAt = time(drill?.verifiedAt);
  const relativePath = `state/archives/${archiveName}`;
  check(hex.test(archiveSha256 ?? '') && /^[A-Za-z0-9._-]+\.sqlite$/.test(archiveName) &&
    backup?.version === 1 && backup.kind === 'encrypted-backup' &&
    hex.test(backup.sha256 ?? '') && Number.isSafeInteger(backup.bytes) && backup.bytes > 0 &&
    Number.isFinite(createdAt) && createdAt <= now,
  'RETIRE_BACKUP_RESULT_INVALID');
  check(copy?.version === 1 && copy.kind === 'backup-copy' &&
    copy.sha256 === backup.sha256 && copy.bytes === backup.bytes &&
    /^ante-up-\d{8}T\d{6}Z\.aub$/.test(copy.artifact ?? '') &&
    copy.verification === 'destination-readback-sha256' &&
    Number.isFinite(copiedAt) && copiedAt >= createdAt && copiedAt <= now,
  'RETIRE_BACKUP_COPY_INVALID');
  check(drill?.version === 1 && drill.kind === 'isolated-restore-drill' &&
    drill.backupSha256 === backup.sha256 && drill.hashes === 'matched' &&
    Number.isFinite(restoredAt) && restoredAt >= copiedAt && restoredAt <= now &&
    now - restoredAt <= 48 * 60 * 60 * 1000,
  'RETIRE_BACKUP_DRILL_INVALID');
  check(drill.snapshotArchive?.kind === 'snapshot-archive-verified' &&
    drill.snapshotArchive.relativePath === relativePath &&
    drill.snapshotArchive.sha256 === archiveSha256 &&
    Number.isSafeInteger(drill.snapshotArchive.bytes) && drill.snapshotArchive.bytes > 0,
  'RETIRE_BACKUP_ARCHIVE_INVALID');
  return { backupSha256: backup.sha256, archiveSha256, archiveRelativePath: relativePath,
    copiedAt: copy.verifiedAt, restoredAt: drill.verifiedAt };
}
