import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {SqliteKeeperAttempts} from '../src/attempts.ts';
import {advanceEmptyLpRecovery,planEmptyLpRecovery,type EmptyWindowState} from '../src/lp-recovery.ts';

const work=resolve(import.meta.dirname,'../../../../work/d-keeper-recovery');mkdirSync(work,{recursive:true});
const now=1_800_000_000,marketId='market';
const base:EmptyWindowState={marketId,cycle:'0',currentMaturity:0,openPositions:0,totalShares:'1000',
  lpGeneration:'1',validityGeneration:'2',lastLpMaturity:1_799_000_000,
  lpWindowStart:now-1000,lpWindowEnd:now-100,navValid:true};

test('empty-cycle validity reset is due without any settlement candidate',()=>{
  assert.equal(planEmptyLpRecovery(base,marketId,now).state,'ready');
  assert.equal(planEmptyLpRecovery({...base,navValid:false},marketId,now).state,'notDue');
  assert.equal(planEmptyLpRecovery({...base,openPositions:1},marketId,now).state,'notDue');
  assert.equal(planEmptyLpRecovery({...base,currentMaturity:now+1000},marketId,now).state,'notDue');
  assert.equal(planEmptyLpRecovery({...base,lpGeneration:'2',lpWindowEnd:now+100},marketId,now).state,'notDue');
});

test('weekly LP rollover uses the Monday boundary with an accelerated clock',()=>{
  const thisMonday=Math.floor((now-345_600)/604_800)*604_800+345_600;
  const sameGeneration={...base,lpGeneration:'2',lastLpMaturity:thisMonday};
  assert.equal(planEmptyLpRecovery(sameGeneration,marketId,now).state,'notDue');
  assert.equal(planEmptyLpRecovery(sameGeneration,marketId,thisMonday+604_800).state,'ready');
});

test('recovery submits once, persists unknown signature and resumes after finalized state',async()=>{
  const attempts=new SqliteKeeperAttempts(resolve(work,`${randomUUID()}.sqlite`));
  let sends=0;let current=structuredClone(base);
  const chain={async readEmptyWindow(){return current;},async verifyAttempt(){return 'PENDING' as const;},
    async startLpWindow(_marketId:string,onSigned?:(signature:string)=>void){sends++;onSigned?.('signed');throw Error('lost response');}};
  const input={marketId,chain,attempts,now};
  assert.deepEqual(await advanceEmptyLpRecovery(input),{state:'unknown',signature:'signed'});
  assert.deepEqual(await advanceEmptyLpRecovery(input),{state:'unknown',signature:'signed'});
  assert.equal(sends,1);
  current={...current,lpGeneration:'2',lpWindowStart:now,lpWindowEnd:now+900};
  assert.deepEqual(await advanceEmptyLpRecovery(input),{state:'notDue',signature:null});
  attempts.close();
});

test('a later generation cannot send while an older recovery signature is unresolved',async()=>{
  const attempts=new SqliteKeeperAttempts(resolve(work,`${randomUUID()}.sqlite`));
  let state=structuredClone(base),sends=0;
  const chain={async readEmptyWindow(){return state;},async verifyAttempt(){return 'PENDING' as const;},
    async startLpWindow(_marketId:string,onSigned?:(signature:string)=>void){sends++;onSigned?.(`sig-${sends}`);return `sig-${sends}`;}};
  assert.equal((await advanceEmptyLpRecovery({marketId,chain,attempts,now})).state,'submitted');
  state={...state,validityGeneration:'3'};
  assert.equal((await advanceEmptyLpRecovery({marketId,chain,attempts,now:now+604_800})).state,'unknown');
  assert.equal(sends,1);
  attempts.close();
});
