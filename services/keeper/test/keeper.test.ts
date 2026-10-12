import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeDueEpoch, openLpWindowWhenReady, resumeProAfterLpWindow } from '../src/index.ts';

test('keeper avoids early and duplicate calls, returns unknown after timeout', async () => {
  let calls = 0;
  let unknown = false;
  const adapter: any = {
    async readTarget() { return { marketId: 'm', epochId: 'e', maturityAt: 100, state: 'SETTLING', settlementInput: { candidateHash: 'a'.repeat(64), priceAtoms: '10', dataThrough: 100, finalized: true, mode:'NORMAL', maturityAt:100, eligibleAt:1000, effectiveCloseAt:100, outageStartedAt:null } }; },
    async findExistingExecution() { return null; },
    async hasUnresolvedAttempt() { return unknown; },
    async markUnknown() { unknown = true; },
    async submitFinalize() { calls++; throw new Error('RPC timeout'); }
  };
  assert.equal((await finalizeDueEpoch(adapter, 'm', 'e', 99)).state, 'notDue');
  assert.equal(calls, 0);
  assert.equal((await finalizeDueEpoch(adapter, 'm', 'e', 999)).state, 'notDue');
  assert.equal((await finalizeDueEpoch(adapter, 'm', 'e', 1000)).state, 'unknown');
  assert.equal(calls, 1);
  assert.equal((await finalizeDueEpoch(adapter, 'm', 'e', 1001)).state, 'unknown');
  assert.equal(calls, 1);
  adapter.findExistingExecution = async () => 'sig';
  assert.deepEqual(await finalizeDueEpoch(adapter, 'm', 'e', 1001), { state: 'existing', signature: 'sig' });
  assert.equal(calls, 1);
});

test('24-hour outage emergency settlement may precede weekly maturity', async () => {
  let calls=0;
  const target:any={marketId:'m',epochId:'e',maturityAt:200_000,state:'SETTLING',settlementInput:{candidateHash:'b'.repeat(64),priceAtoms:'7',dataThrough:99,finalized:true,mode:'EMERGENCY',maturityAt:200_000,eligibleAt:86_500,effectiveCloseAt:86_500,outageStartedAt:100}};
  const adapter:any={async readTarget(){return target;},async findExistingExecution(){return null;},async hasUnresolvedAttempt(){return false;},async markUnknown(){},async submitFinalize(){calls++;return 'sig';}};
  assert.equal((await finalizeDueEpoch(adapter,'m','e',86_499)).state,'notDue');
  assert.equal((await finalizeDueEpoch(adapter,'m','e',86_500)).state,'submitted');
  assert.equal(calls,1);
  target.settlementInput.eligibleAt=86_499;
  await assert.rejects(()=>finalizeDueEpoch(adapter,'m','e',86_500),/KEEPER_SETTLEMENT_INPUT_INVALID/);
});

test('recovery settlement preserves original maturity and accepts outage provenance',async()=>{
  const target:any={marketId:'m',epochId:'e',maturityAt:100,state:'SETTLING',settlementInput:{candidateHash:'c'.repeat(64),priceAtoms:'8',dataThrough:100,finalized:true,mode:'RECOVERY',maturityAt:100,eligibleAt:1200,effectiveCloseAt:100,outageStartedAt:90}};
  const adapter:any={async readTarget(){return target;},async findExistingExecution(){return null;},async hasUnresolvedAttempt(){return false;},async markUnknown(){},async submitFinalize(){return 'sig';}};
  assert.equal((await finalizeDueEpoch(adapter,'m','e',1199)).state,'notDue');
  assert.equal((await finalizeDueEpoch(adapter,'m','e',1200)).state,'submitted');
  target.settlementInput.effectiveCloseAt=1200;
  await assert.rejects(()=>finalizeDueEpoch(adapter,'m','e',1200),/KEEPER_SETTLEMENT_INPUT_INVALID/);
});

test('LP opens immediately after fixed payouts and valid NAV; Pro waits 900 continuous seconds', async () => {
  let calls=0, unknown=false;
  const target={marketId:'m',epochId:'e',state:'SETTLING',allPayoutsFixed:false,validNavSince:100,navCurrentlyValid:true};
  const adapter:any={
    async readWindowTarget(){return target;},
    async findExistingWindow(){return null;},
    async hasUnresolvedWindowAttempt(){return unknown;},
    async markWindowUnknown(){unknown=true;},
    async submitOpenWindow(){calls++;throw new Error('timeout');},
    async findExistingResume(){return null;},
    async hasUnresolvedResumeAttempt(){return false;},
    async markResumeUnknown(){},
    async submitResumePro(){calls++;return 'pro-sig';}
  };
  assert.equal((await openLpWindowWhenReady(adapter,'m','e',100)).state,'notDue');
  target.allPayoutsFixed=true;
  target.navCurrentlyValid=false;
  assert.equal((await openLpWindowWhenReady(adapter,'m','e',100)).state,'notDue');
  target.navCurrentlyValid=true;
  assert.equal((await openLpWindowWhenReady(adapter,'m','e',100)).state,'unknown');
  assert.equal(calls,1);
  assert.equal((await openLpWindowWhenReady(adapter,'m','e',1001)).state,'unknown');
  assert.equal(calls,1);
  target.state='LP_WINDOW';
  assert.equal((await resumeProAfterLpWindow(adapter,'m','e',999)).state,'notDue');
  assert.equal((await resumeProAfterLpWindow(adapter,'m','e',1000)).state,'submitted');
  assert.equal(calls,2);
  target.validNavSince=1001;
  assert.equal((await resumeProAfterLpWindow(adapter,'m','e',1002)).state,'notDue');
});
