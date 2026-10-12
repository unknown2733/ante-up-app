import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureRecords } from '../../api/src/fixture.ts';
import { FinalizedPoller, missingProgramDecoder, type ProgramEventDecoder } from '../src/poller.ts';
import { SqliteProjectionStore, type StreamKey } from '../src/sqlite.ts';
import type { FinalizedRpc, FinalizedEvidence, SignatureInfo } from '../src/rpc.ts';
import type { ChainEvent } from '../src/index.ts';
import { SqliteEventRepositories } from '../src/repositories.ts';

const key: StreamKey = { cluster: 'localnet', programId: 'P', address: 'P' };
const closed = fixtureRecords(1800000000).find(r => r.id === 'fixture:alice-win')!;
const opened: any = { ...closed, status: 'OPEN', exit: null, result: null, proofId: null };
const signatures: SignatureInfo[] = [
  { signature: 'proof', slot: '13', failed: false },
  { signature: 'close', slot: '12', failed: false },
  { signature: 'open', slot: '11', failed: false }
];
const transactionIndex: Record<string, number> = { proof: 0, close: 0, open: 0, 'proof-later': 0 };
const events: Record<string, ChainEvent[]> = {
  open: [{ ...key, signature: 'open', slot: '11', transactionIndex: 0, eventIndex: 0, finality: 'finalized', kind: 'freeRecord', record: opened }],
  close: [{ ...key, signature: 'close', slot: '12', transactionIndex: 0, eventIndex: 0, finality: 'finalized', kind: 'freeRecord', record: closed }],
  proof: [{ ...key, signature: 'proof', slot: '13', transactionIndex: 0, eventIndex: 0, finality: 'finalized', kind: 'proofLink', recordId: closed.id, proofId: 'fixture:proof-alice-v2' }]
};
class FixtureRpc implements FinalizedRpc {
  listed: string[] = [];
  reads: string[] = [];
  rows: SignatureInfo[];
  constructor(rows: SignatureInfo[]) { this.rows = rows; }
  async listSignatures(_programId: string, before: string | null, limit: number) {
    this.listed.push(before ?? 'HEAD');
    const start = before ? this.rows.findIndex(item => item.signature === before) + 1 : 0;
    if (before && start === 0) throw new Error('UNKNOWN_BEFORE');
    return this.rows.slice(start, start + limit);
  }
  async getEvidence(signature: string, slot: string): Promise<FinalizedEvidence> {
    this.reads.push(signature);
    return { signature, slot, transactionIndex: transactionIndex[signature], transaction: ['synthetic', 'base64'], meta: { err: null } };
  }
}
const decoder: ProgramEventDecoder = { async decodeFinalized(evidence) { return events[evidence.signature] ?? []; } };
function temporaryDb<T>(run: (filename: string) => Promise<T>): Promise<T> {
  const workRoot = fileURLToPath(new URL('../../../../work/', import.meta.url));
  mkdirSync(workRoot, { recursive: true });
  const dir = mkdtempSync(join(workRoot, 'ante-up-indexer-'));
  // The sandbox disallows removing a freshly closed SQLite directory on Windows.
  // Test files stay under the task's work/ scratch area, outside the repository.
  return run(join(dir, 'index.sqlite'));
}

test('durable backfill resumes after restart and projects one finalized record', () => temporaryDb(async filename => {
  const rpc = new FixtureRpc(signatures);
  let store = new SqliteProjectionStore(filename);
  const first = await new FinalizedPoller(store, rpc, decoder, 2).pollOnce(key);
  assert.equal(first.state, 'scanning');
  assert.equal(store.cursor(key).scanBefore, 'close');
  assert.equal(store.eventCount(), 0);
  store.close();
  store = new SqliteProjectionStore(filename);
  const completed = await new FinalizedPoller(store, rpc, decoder, 2).pollOnce(key);
  assert.equal(completed.state, 'applied');
  assert.equal(completed.headSignature, 'proof');
  assert.deepEqual(rpc.reads.toSorted(), ['close', 'open', 'proof']);
  assert.equal(store.records('localnet', 'P').length, 1);
  assert.equal(store.records('localnet', 'P')[0].status, 'CLOSED_RESULT');
  assert.equal(store.records('localnet', 'P')[0].proofId, 'fixture:proof-alice-v2');
  assert.equal(store.eventCount(), 3);
  store.close();
  store = new SqliteProjectionStore(filename);
  assert.equal(store.cursor(key).headSignature, 'proof');
  const repeat = await new FinalizedPoller(store, rpc, decoder, 2).pollOnce(key);
  assert.equal(repeat.events, 0);
  assert.equal(store.eventCount(), 3);
  store.close();
}));

test('missing generated decoder fails closed and pending scan survives retry', () => temporaryDb(async filename => {
  const store = new SqliteProjectionStore(filename);
  const rpc = new FixtureRpc([signatures[2]]);
  await assert.rejects(new FinalizedPoller(store, rpc, missingProgramDecoder, 3).pollOnce(key), /GENERATED_PROGRAM_DECODER_REQUIRED/);
  assert.equal(store.cursor(key).headSignature, null);
  assert.equal(store.pending(key).length, 1);
  const resumed = await new FinalizedPoller(store, rpc, decoder, 3).pollOnce(key);
  assert.equal(resumed.events, 1);
  assert.equal(store.records('localnet', 'P')[0].status, 'OPEN');
  store.close();
}));

test('provenance mismatch and history gap never advance durable cursor', () => temporaryDb(async filename => {
  const store = new SqliteProjectionStore(filename);
  const rpc = new FixtureRpc([signatures[2]]);
  const wrong: ProgramEventDecoder = { async decodeFinalized(evidence) { return [{ ...events.open[0], slot: '999' }]; } };
  await assert.rejects(new FinalizedPoller(store, rpc, wrong, 3).pollOnce(key), /PROVENANCE_MISMATCH/);
  assert.equal(store.cursor(key).headSignature, null);
  await new FinalizedPoller(store, rpc, decoder, 3).pollOnce(key);
  rpc.rows = [{ signature: 'other', slot: '20', failed: false }];
  await assert.rejects(new FinalizedPoller(store, rpc, decoder, 3).pollOnce(key), /HISTORY_GAP/);
  assert.equal(store.cursor(key).headSignature, 'open');
  store.close();
}));

test('an existing poller reloads a later E proof job before retrying its pending event', () => temporaryDb(async filename => {
  const store = new SqliteProjectionStore(filename);
  const repositories = new SqliteEventRepositories(filename, { async get() { return null; } });
  const proofPath = join(dirname(filename), 'proofs.json');
  const proofHash = 'a'.repeat(64);
  const rpc = new FixtureRpc([{ signature: 'proof-later', slot: '21', failed: false }]);
  const lateDecoder: ProgramEventDecoder = { async decodeFinalized(_evidence, scope) {
    assert.equal(await repositories.resolve({recordAddress:'record',proofHash,scope}), 'proof:record:original');
    return [];
  } };
  const refresh = async (scope: StreamKey) => {
    try { await repositories.importProofFile(proofPath, scope); }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
  };
  const poller = new FinalizedPoller(store, rpc, lateDecoder, 3, refresh);
  await assert.rejects(poller.pollOnce(key), /PROOF_ID_UNRESOLVED/);
  assert.equal(store.cursor(key).headSignature, null);
  writeFileSync(proofPath, JSON.stringify({
    'proof:record:original': {id:'proof:record:original',recordId:'record',payloadHash:proofHash,
      manifestRef:null,state:'UPLOADED',artifacts:[],confirmations:null,sasId:null,retryAt:null,error:null,replacementId:null}
  }));
  const retry = await poller.pollOnce(key);
  assert.equal(retry.state, 'applied');
  assert.equal(store.cursor(key).headSignature, 'proof-later');
  repositories.close(); store.close();
}));
