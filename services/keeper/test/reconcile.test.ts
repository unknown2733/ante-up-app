import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteKeeperAttempts, type KeeperAction} from '../src/attempts.ts';
import {reconcileKeeperAttempts} from '../src/reconcile.ts';

test('idle reconciliation covers all actions and preserves uncertain attempts without retrying',async()=>{
 const attempts=new SqliteKeeperAttempts(':memory:');
 try {
  const actions:KeeperAction[]=['ACCEPT_SETTLEMENT','SETTLE_PRO','START_LP_WINDOW','RECOVER_LP_WINDOW'];
  const keys=actions.map((action,i)=>({action,marketId:'market',cycle:String(i+1),
    entity:action==='SETTLE_PRO'?'position':action==='RECOVER_LP_WINDOW'?'week:generation':''}));
  const reserved=keys.map(key=>attempts.reserve(key,'a'.repeat(64),1).attempt);
  for(const attempt of reserved.slice(0,3)) attempts.attachSignature(attempt,'signature-'+attempt.cycle,2);
  const other=attempts.reserve({...keys[0],marketId:'other'},'b'.repeat(64),1).attempt;
  const seen:string[]=[];
  const first=await reconcileKeeperAttempts({marketId:'market',attempts,now:3,verify:async a=>{
    seen.push(a.action);return a.action==='START_LP_WINDOW'?'FAILED':a.signature?'FINALIZED':'PENDING';
  }});
  assert.deepEqual(first,{checked:4,finalized:2,failed:1,pending:1});
  assert.deepEqual(seen,actions);
  assert.equal(attempts.get(keys[3])?.state,'UNKNOWN');
  assert.equal(attempts.get(keys[3])?.generation,1);
  assert.equal(attempts.get(other)?.state,'UNKNOWN');
  const second=await reconcileKeeperAttempts({marketId:'market',attempts,now:4,verify:async a=>{
    assert.equal(a.action,'RECOVER_LP_WINDOW');return 'FINALIZED';
  }});
  assert.deepEqual(second,{checked:1,finalized:1,failed:0,pending:0});
  assert.deepEqual(await reconcileKeeperAttempts({marketId:'market',attempts,now:5,
    verify:async()=>{throw Error('ALREADY_RECONCILED');}}),{checked:0,finalized:0,failed:0,pending:0});
 } finally {attempts.close();}
});

test('RPC failure leaves a submitted attempt intact for later reconciliation',async()=>{
 const attempts=new SqliteKeeperAttempts(':memory:');
 try {
  const key={action:'RECOVER_LP_WINDOW' as const,marketId:'market',cycle:'1',entity:'week:generation'};
  const attempt=attempts.reserve(key,'a'.repeat(64),1).attempt;
  attempts.attachSignature(attempt,'original-signature',2);
  await assert.rejects(reconcileKeeperAttempts({marketId:'market',attempts,now:3,
    verify:async()=>{throw Error('RPC_UNAVAILABLE');}}),/RPC_UNAVAILABLE/);
  assert.deepEqual(attempts.get(key),{...attempt,state:'SUBMITTED',signature:'original-signature'});
 } finally {attempts.close();}
});
