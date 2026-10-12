import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreeProjectionGate } from '../src/freeProjection.ts';

const marker = {wallet:'alice',cluster:'devnet',marketId:'solana',action:'openFree',recordId:'record-1',requestId:'request-1',signature:'sig-1'};
const record = {id:'record-1',wallet:'alice',marketId:'solana',status:'OPEN',finality:'finalized'};
const profile = (records = []) => ({wallet:'alice',openRecords:records,closedRecords:[]});
function storage() { const map = new Map(); return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)}; }

test('finalized execution barrier survives remount and reload without storing session credentials', () => {
  const disk = storage();
  createFreeProjectionGate(disk).remember(marker);
  const reopened = createFreeProjectionGate(disk);
  assert.deepEqual(reopened.pending(marker),marker);
  assert.equal(reopened.observe(marker,profile()),false);
  assert.equal(reopened.observe(marker,profile([{...record,finality:'confirmed'}])),false);
  assert.equal(reopened.observe(marker,profile([record])),true);
  assert.equal(createFreeProjectionGate(disk).pending(marker),null);
});
test('only matching market, wallet and exact finalized record can release the barrier', () => {
  const gate = createFreeProjectionGate(); gate.remember(marker);
  assert.equal(gate.pending({...marker,wallet:'bob'}),null);
  assert.equal(gate.pending({...marker,marketId:'bitcoin'}),null);
  assert.equal(gate.observe(marker,{...profile([record]),wallet:'bob'}),false);
  assert.equal(gate.observe(marker,profile([{...record,id:'earlier-record'}])),false);
  assert.equal(gate.observe(marker,profile([{...record,marketId:'bitcoin'}])),false);
});
test('close cannot unlock on stale OPEN; exact CLOSED_RESULT or CLOSED_NA unlocks', () => {
  for (const status of ['CLOSED_RESULT','CLOSED_NA']) {
    const gate = createFreeProjectionGate(); gate.remember({...marker,action:'closeFree'});
    assert.equal(gate.observe(marker,profile([record])),false);
    assert.equal(gate.observe(marker,{...profile(),closedRecords:[{...record,status}]}),true);
  }
});
