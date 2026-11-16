import test from 'node:test';import assert from 'node:assert/strict';
import {expireUnlandedPublication,isPendingPublication} from './publication-recovery.mjs';
import {hash} from './index.mjs';
const job={state:'REQUESTING',market:{address:'market',programId:'program',cluster:'devnet'},sequence:'7',signature:null,
  candidate:{configVersion:'2',queryVersion:'1',queryHash:'query'}};
job.candidateHash=hash(job.candidate);
const proof={version:1,kind:'QUIESCENT_RECENT_BLOCKHASH_EXPIRY',marketId:'market',programId:'program',sequence:'7',candidateHash:job.candidateHash,
  originalSignature:null,genesisHash:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',producerId:'stopped-container',
  producerStopped:true,producerStillStopped:true,capturedAt:10,verifiedAt:90,boundaryBlockhash:'post-stop-blockhash',
  producerStoppedAt:9,boundaryBlockTime:10,boundarySlot:'100',finalizedSlot:'101',
  lastValidBlockHeight:'200',finalizedBlockHeight:'201',boundaryBlockhashValid:false,snapshotExists:false,
  nextSequence:'7',signatureStatus:null,candidateConfigVersion:'2',configVersion:'2',queryVersion:'1',queryHash:'query'};
test('unsigned legacy request only clears after a stopped-producer expiry and absent finalized snapshot',()=>{
  assert.equal(isPendingPublication(job),true);
  const result=expireUnlandedPublication(job,proof);assert.equal(isPendingPublication(result),false);
  assert.equal(result.previousState,'REQUESTING');assert.equal(result.candidateHash,job.candidateHash);
  assert.equal(isPendingPublication({...result,expiryRecoveryHash:'tampered'}),true);
});
test('live producer, live blockhash, landed account, changed sequence or unavailable finality never clear pending',()=>{
  for(const patch of [{producerStillStopped:false},{boundaryBlockhashValid:true},{snapshotExists:true},
    {nextSequence:'8'},{finalizedBlockHeight:'200'},{signatureStatus:{confirmationStatus:'processed'}},
    {configVersion:'1'},{configVersion:'invalid'},{candidateConfigVersion:'3'},{genesisHash:'other'},{candidateHash:'other'},
    {boundaryBlockTime:8},{finalizedSlot:'99'},{programId:'other'}])
    assert.throws(()=>expireUnlandedPublication(job,{...proof,...patch}),/PROOF_INVALID/);
  assert.equal(isPendingPublication({...job,state:'EXPIRED_UNLANDED'}),true);
});
test('a newer observed configuration does not rewrite or resend an expired old candidate',()=>{
  const before=JSON.stringify(job),result=expireUnlandedPublication(job,{...proof,configVersion:'3'});
  assert.equal(isPendingPublication(result),false);assert.equal(result.candidate.configVersion,'2');
  assert.equal(result.expiryRecovery.candidateConfigVersion,'2');assert.equal(result.expiryRecovery.configVersion,'3');
  assert.equal(result.candidateHash,job.candidateHash);assert.equal(JSON.stringify(job),before);
  assert.throws(()=>expireUnlandedPublication(job,{...proof,candidateConfigVersion:undefined}),/PROOF_INVALID/);
});

test('v2 binds account readback to the specific finalized expiry block; v1 stays historical-compatible',()=>{
 const p={...proof,version:2,readContextSlot:101,expiryBlock:{slot:'101',height:'201'}};
 assert.equal(isPendingPublication(expireUnlandedPublication(job,p)),false);
 for(const patch of [{readContextSlot:100},{expiryBlock:{slot:'100',height:'201'}},{expiryBlock:{slot:'101',height:'202'}},
  {expiryBlock:undefined},{readContextSlot:undefined}])assert.throws(()=>expireUnlandedPublication(job,{...p,...patch}),/PROOF_INVALID/);
 assert.equal(isPendingPublication(expireUnlandedPublication(job,proof)),false);
});
