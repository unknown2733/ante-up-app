import test from 'node:test';
import assert from 'node:assert/strict';
import {marketSigningBlocked} from '../src/financialSigning.ts';

test('a prepared quote cannot start signing after sync/stale/capability loss; current recovery permits one start',async()=>{
 const ready={busy:false,unavailable:null,pending:null,canExecute:true,remaining:25};
 let state=ready,signs=0,finish;
 const sign=()=>{
  if(marketSigningBlocked(state))return;
  signs++;state={...state,busy:true};
  return new Promise(resolve=>{finish=resolve;});
 };
 for(const reason of ['Syncing latest observation','Observation delayed','Wrong phase','Network mismatch']){
  state={...ready,unavailable:reason};sign();assert.equal(signs,0);
 }
 state=ready;const inFlight=sign();assert.equal(signs,1);
 // A later readiness change cannot cancel or restart an already opened signer.
 state={...state,unavailable:'Syncing latest observation'};sign();assert.equal(signs,1);
 finish({state:'UNKNOWN',signature:'existing'});
 const unknown=await inFlight;assert.equal(unknown.signature,'existing');
 state={...ready,pending:unknown};sign();assert.equal(signs,1);
 // Existing-request reconciliation remains available independently of this new-sign gate.
 let reconciles=0;const recheck=async()=>{reconciles++;return unknown;};
 assert.equal((await recheck()).state,'UNKNOWN');assert.equal(reconciles,1);
 for(const override of [{remaining:0},{remaining:-1},{canExecute:false},{busy:true}])
  assert.equal(marketSigningBlocked({...ready,...override}),true);
 assert.equal(marketSigningBlocked(ready),false);
});
