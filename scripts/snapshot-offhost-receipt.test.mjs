import test from 'node:test';
import assert from 'node:assert/strict';
import { retirementStatus, retireSnapshot, verifyOffhostReceipt } from './retire-snapshot.mjs';

test('retirement requires a recent matching verification receipt from another host', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  const sha = 'a'.repeat(64);
  const archive = { digest: 'b'.repeat(64), snapshots: 3471 };
  const receipt = { version: 1, kind: 'SNAPSHOT_OFFHOST_VERIFICATION',
    host: 'operator-pc', archivePath: 'C:/archive.sqlite', archiveSha256: sha,
    archiveDigest: archive.digest, snapshots: archive.snapshots,
    verifiedAt: '2026-10-29T23:00:00Z' };
  assert.doesNotThrow(() => verifyOffhostReceipt(receipt, archive, sha, now, 'homeserver'));
  for (const bad of [
    { host: 'homeserver' }, { archiveSha256: 'c'.repeat(64) },
    { archiveDigest: 'c'.repeat(64) }, { snapshots: 1 },
    { verifiedAt: '2026-10-27T00:00:00Z' },
    { verifiedAt: '2026-10-31T00:00:00Z' },
  ]) assert.throws(() => verifyOffhostReceipt({ ...receipt, ...bad }, archive, sha, now, 'homeserver'),
    /RETIRE_OFFHOST_RECEIPT_INVALID/);
});

test('retirement only reports completion when the signature is finalized and the account is gone', async () => {
  const prepared = { scope: { address: '8m1sp7nP37ZTPgW1AuKiT1j2KrKgGstX2XzkXrq6PgKf' },
    existing: { signature: 'signature' }, transport: {
      getSignatureStatus: async () => ({ confirmationStatus: 'finalized', err: null }),
      getFinalizedAccount: async () => ({ exists: true }),
    } };
  assert.equal((await retirementStatus({ prepared })).state, 'UNKNOWN');
  prepared.transport.getFinalizedAccount = async () => ({ exists: false });
  assert.equal((await retirementStatus({ prepared })).state, 'FINALIZED');
  prepared.transport.getSignatureStatus = async () => null;
  assert.equal((await retirementStatus({ prepared })).state, 'UNKNOWN');
});

test('existing signed retirement attempt cannot be resent', async () => {
  await assert.rejects(() => retireSnapshot({ prepared: { existing: { signature: 'unknown' } },
    expectedFingerprint: 'a', journalPath: 'unused' }), /RETIRE_EXISTING_ATTEMPT_RECONCILE_FIRST/);
});
