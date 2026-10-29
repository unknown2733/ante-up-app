import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPaidXApproved} from './paid-x-approvals.mjs';

const market={marketId:'7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT',
  seedHex:'6ed2918a13bc8131e711bdb505a7cb41864dc7ba63f71ef1ed4da566d0106549',
  queryHash:'a'.repeat(64),queryVersion:'1'};
const registry={schemaVersion:1,maxMarkets:5,markets:[market]};

test('an exact operator-approved market can collect paid X data',()=>{
  assert.doesNotThrow(()=>assertPaidXApproved(registry,market));
});
test('an unapproved or altered query cannot spend paid X quota',()=>{
  assert.throws(()=>assertPaidXApproved(registry,{...market,marketId:'CyYjBcb4LyuyLN1Akaf2eXXJV5GhFUkaPNb7caLCuHN6'}),/PAID_X_NOT_APPROVED/);
  assert.throws(()=>assertPaidXApproved(registry,{...market,queryHash:'b'.repeat(64)}),/PAID_X_APPROVAL_MISMATCH/);
});
test('six markets or duplicate approvals fail closed',()=>{
  assert.throws(()=>assertPaidXApproved({...registry,markets:Array.from({length:6},(_,i)=>({...market,marketId:market.marketId.slice(0,-1)+String(i+1),queryHash:String(i+1).repeat(64)}))},market),/PAID_X_APPROVAL_INVALID/);
  assert.throws(()=>assertPaidXApproved({...registry,markets:[market,market]},market),/PAID_X_APPROVAL_INVALID/);
});
