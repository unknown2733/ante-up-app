import test from 'node:test';
import assert from 'node:assert/strict';
import {collectorGate} from './collector-gate.mjs';

test('unresolved publication prevents source calls, including unsigned REQUESTING', async()=>{
  let paid=0;
  for(const unresolved of [1,2]) {
    const result=await collectorGate({checkStorage:async()=>{},reconcile:async()=>({unresolved})});
    if(result.ready)paid++;
    assert.equal(result.reason,'PUBLICATION_PENDING');
  }
  assert.equal(paid,0);
});
test('state pressure still reconciles accepted work without admitting new work',async()=>{
  let reconciled=0;
  const result=await collectorGate({checkStorage:async()=>{throw Error('STATE_STORAGE_LIMIT');},
    reconcile:async({allowPreparedResume})=>{assert.equal(allowPreparedResume,false);reconciled++;return {unresolved:0};}});
  assert.equal(reconciled,1);assert.deepEqual(result,{ready:false,reason:'STATE_STORAGE_LIMIT',unresolved:0});
});
test('low physical disk stops journal writes; unknown storage failures fail closed',async()=>{
  let reconciled=0;const reconcile=async()=>{reconciled++;return {unresolved:0};};
  assert.equal((await collectorGate({checkStorage:async()=>{throw Error('HOST_STORAGE_LOW');},reconcile})).ready,false);
  await assert.rejects(()=>collectorGate({checkStorage:async()=>{throw Error('EIO');},reconcile}),/EIO/);
  assert.equal(reconciled,0);
});
test('reconciliation must succeed and explicitly clear pending before source work',async()=>{
  await assert.rejects(()=>collectorGate({checkStorage:async()=>{},reconcile:async()=>{throw Error('HTTP 429');}}),/429/);
  await assert.rejects(()=>collectorGate({checkStorage:async()=>{},reconcile:async()=>({})}),/RECONCILE_RESULT/);
  assert.deepEqual(await collectorGate({checkStorage:async()=>{},reconcile:async({allowPreparedResume})=>{assert.equal(allowPreparedResume,true);return {unresolved:0};}}),{ready:true});
});
