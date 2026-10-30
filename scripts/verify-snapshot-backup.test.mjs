import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySnapshotBackup } from './verify-snapshot-backup.mjs';

const now = Date.parse('2026-10-30T02:00:00Z');
const backupSha256 = 'a'.repeat(64);
const archiveSha256 = 'b'.repeat(64);
const archivePath = '/state/archives/snapshots-20261030-next.sqlite';
const backup = { version: 1, kind: 'encrypted-backup',
  createdAt: '2026-10-29T18:30:00Z', bytes: 9365293788, sha256: backupSha256 };
const copy = { version: 1, kind: 'backup-copy',
  verifiedAt: '2026-10-29T19:15:00Z', artifact: 'ante-up-20261029T183002Z.aub',
  bytes: backup.bytes, sha256: backupSha256, verification: 'destination-readback-sha256' };
const drill = { version: 1, kind: 'isolated-restore-drill',
  verifiedAt: '2026-10-29T19:20:00Z', backupSha256, hashes: 'matched',
  snapshotArchive: { kind: 'snapshot-archive-verified',
    relativePath: 'state/archives/snapshots-20261030-next.sqlite',
    sha256: archiveSha256, bytes: 14700544 } };

const input = { backup, copy, drill, archiveSha256, archivePath, now };

test('retirement accepts only the same recent encrypted backup, copied and restored with the exact archive', () => {
  assert.equal(verifySnapshotBackup(input).backupSha256, backupSha256);
  assert.throws(() => verifySnapshotBackup({ ...input,
    copy: { ...copy, sha256: 'c'.repeat(64) } }), /RETIRE_BACKUP_COPY_INVALID/);
  assert.throws(() => verifySnapshotBackup({ ...input,
    drill: { ...drill, backupSha256: 'c'.repeat(64) } }), /RETIRE_BACKUP_DRILL_INVALID/);
  assert.throws(() => verifySnapshotBackup({ ...input,
    drill: { ...drill, hashes: 'mismatched' } }), /RETIRE_BACKUP_DRILL_INVALID/);
});

test('an earlier backup without the archive cannot authorize retirement', () => {
  assert.throws(() => verifySnapshotBackup({ ...input,
    drill: { ...drill, snapshotArchive: undefined } }), /RETIRE_BACKUP_ARCHIVE_INVALID/);
  assert.throws(() => verifySnapshotBackup({ ...input,
    drill: { ...drill, snapshotArchive: { ...drill.snapshotArchive,
      sha256: 'c'.repeat(64) } } }), /RETIRE_BACKUP_ARCHIVE_INVALID/);
  assert.throws(() => verifySnapshotBackup({ ...input,
    drill: { ...drill, snapshotArchive: { ...drill.snapshotArchive,
      relativePath: 'state/archives/another.sqlite' } } }), /RETIRE_BACKUP_ARCHIVE_INVALID/);
});

test('stale, future, and out-of-order recovery evidence is refused', () => {
  assert.throws(() => verifySnapshotBackup({ ...input,
    now: now + 49 * 60 * 60 * 1000 }), /RETIRE_BACKUP_DRILL_INVALID/);
  assert.throws(() => verifySnapshotBackup({ ...input,
    drill: { ...drill, verifiedAt: '2026-10-30T03:00:00Z' } }), /RETIRE_BACKUP_DRILL_INVALID/);
  assert.throws(() => verifySnapshotBackup({ ...input,
    copy: { ...copy, verifiedAt: '2026-10-29T18:00:00Z' } }), /RETIRE_BACKUP_COPY_INVALID/);
});
