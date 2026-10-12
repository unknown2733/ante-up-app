import test from 'node:test';
import assert from 'node:assert/strict';
import { EventIndex, OperationStore, reconcileUnknown } from '../src/index.ts';
import { fixtureRecords } from '../../api/src/fixture.ts';
import { profile } from '../../api/src/leaderboard.ts';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
test('event identity deduplicates confirmed and finalized; finalized wins', () => {
  const index = new EventIndex();
  const record: any = { id: 'r', wallet: 'w', finality: 'confirmed' };
  const event: any = { cluster: 'devnet', programId: 'p', signature: 's', eventIndex: 0, slot: '10', finality: 'confirmed', kind: 'freeRecord', record };
  assert.equal(index.ingest(event), true);
  assert.equal(index.finalizedRecords().length, 0);
  assert.equal(index.ingest({ ...event, finality: 'finalized', record: { ...record, finality: 'finalized' } }), true);
  assert.equal(index.finalizedRecords().length, 1);
  assert.equal(index.ingest(event), false);
  assert.equal(index.finalizedRecords()[0].finality, 'finalized');
});

test('operation key is wallet+action+requestId; unknown cannot be mistaken for failure', async () => {
  const store = new OperationStore();
  const initial = store.create({ wallet: 'w', action: 'openFree', requestId });
  assert.equal(store.create({ wallet: 'w', action: 'openFree', requestId }).state, initial.state);
  assert.throws(() => store.create({ wallet: 'w2', action: 'openFree', requestId }), /ALREADY_EXECUTED/);
  store.update(requestId, 'UNKNOWN', 'signature1');
  const miss = await reconcileUnknown(store, requestId, { async bySignature() { return null; }, async byContractId() { return null; } });
  assert.equal(miss.state, 'UNKNOWN');
  const found = await reconcileUnknown(store, requestId, { async bySignature() { return 'finalized' as const; }, async byContractId() { return null; } });
  assert.equal(found.state, 'FINALIZED');
  assert.throws(() => store.update(requestId, 'SUBMITTED'), /ALREADY_EXECUTED/);
});

test('out-of-order OPEN then CLOSE and proof link project to one completed record', () => {
  const closed = fixtureRecords(1800000000).find(r => r.id === 'fixture:alice-win')!;
  const open: any = { ...closed, status: 'OPEN', exit: null, result: null, proofId: null };
  const events: any[] = [
    { cluster: 'devnet', programId: 'p', signature: 'close', eventIndex: 0, transactionIndex: 0, slot: '12', finality: 'finalized', kind: 'freeRecord', record: closed },
    { cluster: 'devnet', programId: 'p', signature: 'open', eventIndex: 0, transactionIndex: 0, slot: '11', finality: 'finalized', kind: 'freeRecord', record: open },
    { cluster: 'devnet', programId: 'p', signature: 'proof', eventIndex: 0, transactionIndex: 0, slot: '13', finality: 'finalized', kind: 'proofLink', recordId: closed.id, proofId: 'fixture:proof-alice-v2' }
  ];
  const index = new EventIndex();
  for (const event of events) index.ingest(event);
  assert.equal(index.ingest(events[0]), false);
  assert.equal(index.finalizedRecordsAt({ slot: '11', transactionIndex: 0, eventIndex: 0 })[0].status, 'OPEN');
  assert.equal(index.finalizedRecordsAt({ slot: '12', transactionIndex: 0, eventIndex: 0 })[0].status, 'CLOSED_RESULT');
  assert.equal(index.finalizedRecordsAt({ slot: '12', transactionIndex: 0, eventIndex: 0 })[0].proofId, 'fixture:proof-alice-v1');
  const records = index.finalizedRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'CLOSED_RESULT');
  assert.equal(records[0].proofId, 'fixture:proof-alice-v2');
  const view = profile(records, closed.wallet);
  assert.equal(view.openRecords.length, 0);
  assert.equal(view.closedValidCount, '1');
});

test('same-slot competing transitions need canonical transaction order', () => {
  const closed = fixtureRecords(1800000000).find(r => r.id === 'fixture:alice-win')!;
  const open: any = { ...closed, status: 'OPEN', exit: null, result: null, proofId: null };
  const base: any = { cluster: 'devnet', programId: 'p', eventIndex: 0, slot: '12', finality: 'finalized', kind: 'freeRecord' };
  const index = new EventIndex();
  index.ingest({ ...base, signature: 'open', record: open });
  index.ingest({ ...base, signature: 'close', record: closed });
  assert.throws(() => index.finalizedRecords(), /AMBIGUOUS_CHAIN_ORDER/);
  const ordered = new EventIndex();
  ordered.ingest({ ...base, signature: 'close', transactionIndex: 1, record: closed });
  ordered.ingest({ ...base, signature: 'open', transactionIndex: 0, record: open });
  assert.equal(ordered.finalizedRecords()[0].status, 'CLOSED_RESULT');
});
