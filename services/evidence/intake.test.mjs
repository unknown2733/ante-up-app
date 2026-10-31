import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileIntake,admissionBudget,fundedCapBudget,proofCapacitySnapshot} from './intake.mjs';

test('intake keeps old and newly closed obligations across retries and proof linkage',()=>{
 const closed=id=>({id,finality:'finalized',status:'CLOSED_RESULT',exit:{executedAt:1},proofId:null});
 const first=reconcileIntake([closed('old'),closed('new'),{...closed('open'),status:'OPEN'}],
  {'proof:old:original':{state:'CONFIRMING'}},undefined,100);
 assert.equal(first.obligations.old.state,'PROCESSING');
 assert.equal(first.obligations.new.state,'WAITING');
 assert.equal(first.obligations.open,undefined);
 const second=reconcileIntake([{...closed('old'),proofId:'proof:old:original'}],{},first,200);
 assert.equal(second.obligations.old.state,'LINKED');
 assert.equal(second.obligations.old.firstSeenAt,100);
 assert.equal(second.obligations.new.state,'WAITING');
});

test('a funded cap reserves every unspent lifetime admission, including concurrent opens',()=>{
 const ledger={version:1,reservations:{}};
 const base={ledger,totalLimit:'30000000000',dailyLimit:'30000000000',perRecordLimit:'15000000000',
  balanceWinc:'30000000000',now:Date.parse('2026-10-16T01:00:00Z')};
 assert.equal(fundedCapBudget({...base,fundedOpenCount:0,cap:2,outstanding:0}).admit,true);
 assert.equal(fundedCapBudget({...base,fundedOpenCount:0,cap:3,outstanding:0}).reason,'TOTAL_BUDGET');
 assert.equal(fundedCapBudget({...base,fundedOpenCount:1,cap:2,outstanding:1}).admit,true);
 assert.equal(fundedCapBudget({...base,fundedOpenCount:1,cap:2,outstanding:0}).admit,true);
 assert.throws(()=>fundedCapBudget({...base,fundedOpenCount:2,cap:2,outstanding:0}),/EVIDENCE_CAP_INVALID/);
});

test('proof capacity counts remaining funded chips and already accepted proof duty',()=>{
 const gate={fundedOpenCap:20n,fundedOpenCount:8n,outstanding:2};
 const covered=proofCapacitySnapshot({gate,balanceWinc:'900',perRecordLimitWinc:'60',now:100});
 assert.deepEqual({remaining:covered.fundedRemaining,required:covered.requiredWinc,
  covered:covered.fullyCovered},{remaining:'12',required:'840',covered:true});
 assert.equal(proofCapacitySnapshot({gate,balanceWinc:'839',perRecordLimitWinc:'60',now:100}).fullyCovered,false);
 assert.throws(()=>proofCapacitySnapshot({gate:{...gate,fundedOpenCount:21n},
  balanceWinc:'900',perRecordLimitWinc:'60',now:100}),/EVIDENCE_CAP_INVALID/);
});

test('budget reserves accepted outstanding duties plus one new record without changing caps',()=>{
 const day='2026-10-16',ledger={version:1,reservations:{['a'.repeat(64)]:{winc:'80000000000',day,
  byDay:{[day]:'10000000000'}}}};
 const input={ledger,totalLimit:'100000000000',dailyLimit:'60000000000',perRecordLimit:'15000000000',
  now:Date.parse('2026-10-16T01:00:00Z')};
 assert.equal(admissionBudget({...input,outstanding:0}).admit,true);
 assert.equal(admissionBudget({...input,outstanding:1}).reason,'TOTAL_BUDGET');
 assert.equal(admissionBudget({...input,ledger:{version:1,reservations:{}},balanceWinc:'14999999999',outstanding:0}).reason,'TURBO_BALANCE');
 assert.equal(admissionBudget({...input,outstanding:4}).acceptedObligationReserveWinc,'60000000000');
 assert.equal(admissionBudget({...input,ledger:{...ledger,reservations:{['a'.repeat(64)]:{winc:'10000000000',day,byDay:{[day]:'50000000000'}}}},outstanding:0}).reason,'DAILY_BUDGET');
 assert.throws(()=>admissionBudget({...input,ledger:{version:1,reservations:{bad:{winc:'0'}}},outstanding:0}),/EVIDENCE_BUDGET_INVALID/);
});
