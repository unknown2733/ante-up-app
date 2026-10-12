import test from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionReason, AdmissionState, DataStatus } from '../../../clients/chain/dist/index.js';
import { hash } from '../../data/index.mjs';
import { fixtureMarkets } from '../../api/src/fixture.ts';
import { snapshotViewFromGenerated, verifyPublishedSnapshot } from '../src/snapshot.ts';

test('generated immutable account and canonical C candidate must match sparse event hash', () => {
  const candidate = structuredClone(fixtureMarkets[0].snapshot!.payload);
  const payloadHash = hash(candidate);
  const marketAddress = '11111111111111111111111111111111';
  const programId = 'Vote111111111111111111111111111111111111111';
  const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
  const version = new Uint8Array(16);
  version.set(new TextEncoder().encode(candidate.formulaVersion));
  const account = snapshotViewFromGenerated({
    discriminator: new Uint8Array(8), market: marketAddress, sequence: BigInt(candidate.sequence),
    payloadHash: bytes(payloadHash), evidenceHash: bytes(candidate.evidenceHash), queryHash: bytes(candidate.queryHash),
    queryVersion: BigInt(candidate.queryVersion), configVersion: BigInt(candidate.configVersion), formulaVersion: version,
    dataThrough: BigInt(candidate.dataThrough), publishedAt: BigInt(candidate.computedAt),
    activityNowQ12: {__option: 'Some', value: BigInt(candidate.activityNowQ12!)},
    activity7dQ12: {__option: 'Some', value: BigInt(candidate.activity7dQ12!)},
    dataStatus: DataStatus.Valid,
    admission: {state: AdmissionState.Blocked, recoveryCount: 0,
      reason: {__option: 'Some', value: AdmissionReason.PendingConfirmation}},
  }, 'snapshot-address', programId);
  const input = {cluster: 'localnet' as const, programId, signature: 'signature', slot: '9',
    marketAddress, marketId: candidate.marketId, sequence: candidate.sequence,
    eventPayloadHash: payloadHash, candidate, account};
  assert.equal(verifyPublishedSnapshot(input).payloadHash, payloadHash);
  const reordered = {...candidate, admission: {reason: candidate.admission.reason,
    recoveryCount: candidate.admission.recoveryCount, state: candidate.admission.state}};
  assert.equal(verifyPublishedSnapshot({...input, candidate: reordered}).payloadHash, payloadHash,
    'canonical JSON transport may reorder object keys without changing the snapshot');
  assert.throws(() => verifyPublishedSnapshot({...input, eventPayloadHash: 'f'.repeat(64)}), /SNAPSHOT_HASH_MISMATCH/);
  assert.throws(() => verifyPublishedSnapshot({...input, account: {...account, ownerProgramId: marketAddress}}), /MARKET_IDENTITY_MISMATCH/);
});
