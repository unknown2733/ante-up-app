import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completedRetirements, executeRetirementBatch, planRetirementBatch }
  from './retire-snapshot-batch.mjs';

const address = '8m1sp7nP37ZTPgW1AuKiT1j2KrKgGstX2XzkXrq6PgKf';
const another = '7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT';
const programId = 'FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const scope = { version: 1, cluster: 'devnet', programId, address,
  market: another, sequence: '1', publisher: address, admin: another,
  archiveSha256: 'a'.repeat(64), backupSha256: 'b'.repeat(64), refundableLamports: '1991360' };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('only finalized, scope-bound journals exclude immutable archived snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-retire-batch-'));
  const path = join(dir, `${address}.json`);
  const journal = { version: 1, scope, fingerprint: fingerprint(scope),
    signature: '3oa9T4w8VWWph2kYSevdGCRfPFcagJ7LzdNAvcusXqoftwBC6qLeB3of98bMY3YffVbiU3wsQvWLwcndehDPCa2P',
    state: 'FINALIZED' };
  try {
    await writeFile(path, JSON.stringify(journal));
    assert.deepEqual([...await completedRetirements(dir)], [address]);
    let completed;
    const plan = async input => { completed = input.completedAddresses; return {
      mode: 'READ_ONLY', archiveSha256: scope.archiveSha256, batch: [] }; };
    await planRetirementBatch({ journalDir: dir, archivePath: 'archive',
      expectedSha256: scope.archiveSha256, rpcFile: 'rpc', plan });
    assert.ok(completed.has(address));
    await writeFile(path, JSON.stringify({ ...journal, state: 'SIGNED' }));
    await assert.rejects(completedRetirements(dir), /RETIRE_BATCH_INCOMPLETE_ATTEMPT/);
    await writeFile(path, JSON.stringify({ ...journal, fingerprint: 'c'.repeat(64) }));
    await assert.rejects(completedRetirements(dir), /RETIRE_BATCH_JOURNAL_INVALID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an unknown first retirement stops the batch before signing another account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-retire-batch-stop-'));
  try {
    let preparedCount = 0, signedCount = 0;
    const result = await executeRetirementBatch({ journalDir: dir, archivePath: 'archive',
      expectedSha256: scope.archiveSha256, rpcFile: 'rpc', signerFile: 'publisher',
      adminSignerFile: 'admin', limit: 2, pilotAcknowledged: true,
      plan: async () => ({ mode: 'READ_ONLY', archiveSha256: scope.archiveSha256,
        batch: [{ address, market: another, sequence: '1' },
          { address: another, market: address, sequence: '2' }] }),
      prepare: async input => { preparedCount++; return {
        scope: { address: input.address, market: another, sequence: '1',
          archiveSha256: scope.archiveSha256 }, fingerprint: 'digest', existing: null }; },
      retire: async () => { signedCount++; return { state: 'UNKNOWN', signature: 'unknown' }; } });
    assert.equal(result.state, 'STOPPED');
    assert.equal(result.results.length, 1);
    assert.equal(preparedCount, 1);
    assert.equal(signedCount, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('batch limit cannot exceed the bounded planner maximum', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-retire-batch-limit-'));
  try {
    await assert.rejects(planRetirementBatch({ journalDir: dir, archivePath: 'archive',
      expectedSha256: scope.archiveSha256, rpcFile: 'rpc', limit: 17, plan: async () => ({ batch: [] }) }),
    /RETIRE_BATCH_LIMIT_INVALID/);
    await assert.rejects(planRetirementBatch({ journalDir: dir, archivePath: 'archive',
      expectedSha256: scope.archiveSha256, rpcFile: 'rpc', limit: 1,
      plan: async () => ({ mode: 'READ_ONLY', archiveSha256: scope.archiveSha256,
        batch: [{ address, market: another, sequence: '1' },
          { address, market: another, sequence: '1' }] }) }),
    /RETIRE_BATCH_PLAN_INVALID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('multi-account execution requires a separately verified pilot', async () => {
  await assert.rejects(executeRetirementBatch({ journalDir: 'unused', archivePath: 'archive',
    expectedSha256: scope.archiveSha256, rpcFile: 'rpc', signerFile: 'publisher',
    adminSignerFile: 'admin', limit: 2 }), /RETIRE_BATCH_PILOT_REQUIRED/);
});
