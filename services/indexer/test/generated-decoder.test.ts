import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FreeState, NaReason, getFreeOpenedEventEncoder, getFreeClosedEventEncoder,
  getProofCompletedEventEncoder, getSnapshotPublishedEventEncoder,
} from '../../../clients/chain/dist/index.js';
import { EventIndex } from '../src/index.ts';
import { GeneratedProgramEventDecoder } from '../src/generated-decoder.ts';

const programId = '11111111111111111111111111111111';
const other = 'Vote111111111111111111111111111111111111111';
const owner = 'Stake11111111111111111111111111111111111111';
const market = 'BPFLoaderUpgradeab1e11111111111111111111111';
const record = 'SysvarRent111111111111111111111111111111111';
const scope = {cluster: 'localnet' as const, programId, address: programId};
const point = {sequence: 1n, payloadHash: new Uint8Array(32).fill(1), executedAt: 100n,
  slot: 10n, hNum: 2n, hDen: 3n, usable: true, reason: NaReason.None};
const log = (data: Uint8Array) => `Program data: ${Buffer.from(data).toString('base64')}`;
const evidence = (logMessages: string[]) => ({signature: 'sig', slot: '10', transactionIndex: 2,
  transaction: null, meta: {logMessages}});

test('generated Anchor events project historical open, close, and proof in order', async () => {
  const opened = getFreeOpenedEventEncoder().encode({record, recordId: 7n, owner, market, entry: point});
  const closed = getFreeClosedEventEncoder().encode({record, recordId: 7n, owner, market,
    state: FreeState.ClosedResult, entry: point, exit: {...point, executedAt: 110n, hNum: 3n},
    resultNegative: false, resultNum: 1n, resultDen: 2n, naReason: NaReason.None});
  const proofHash = new Uint8Array(32).fill(4);
  const proof = getProofCompletedEventEncoder().encode({record, recordId: 7n, owner, market, proofHash});
  const events = await new GeneratedProgramEventDecoder({proofs: {async resolve(input) {
    assert.equal(input.proofHash, '04'.repeat(32));
    return 'proof:record:original';
  }}}).decodeFinalized(evidence([
    `Program ${other} invoke [1]`, log(opened), `Program ${other} success`,
    `Program ${programId} invoke [1]`, log(opened), log(closed), log(proof), `Program ${programId} success`,
  ]), scope);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(e => e.eventIndex), [4, 5, 6]);
  const index = new EventIndex();
  for (const event of events) index.ingest(event);
  const [current] = index.finalizedRecords();
  assert.equal(current.status, 'CLOSED_RESULT');
  assert.deepEqual(current.result, {kind: 'return', numerator: '1', denominator: '2'});
  assert.equal(current.entry.signature, 'sig');
  assert.equal(current.proofId, 'proof:record:original');
});

test('proof hash alone cannot become a public proof ID', async () => {
  const proof = getProofCompletedEventEncoder().encode({record, recordId: 7n, owner, market, proofHash: new Uint8Array(32).fill(4)});
  await assert.rejects(new GeneratedProgramEventDecoder().decodeFinalized(evidence([
    `Program ${programId} invoke [1]`, log(proof), `Program ${programId} success`,
  ]), scope), /PROOF_RESOLVER_REQUIRED/);
});

test('sparse snapshot event stops indexing until immutable candidate and account are resolved', async () => {
  const snapshot = getSnapshotPublishedEventEncoder().encode({market, sequence: 1n, payloadHash: new Uint8Array(32).fill(2)});
  await assert.rejects(new GeneratedProgramEventDecoder().decodeFinalized(evidence([
    `Program ${programId} invoke [1]`, log(snapshot), `Program ${programId} success`,
  ]), scope), /SNAPSHOT_RESOLVER_REQUIRED/);
});
