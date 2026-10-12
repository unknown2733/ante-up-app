import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HISTORY_MINUTES, Q12, hash, replay } from './index.mjs';
import { ANTE_UP_PROGRAM_ADDRESS, findSnapshotPda } from '../../clients/chain/dist/index.js';
import { openOutage } from './outage.mjs';
import { evaluateSettlement, FileSettlementJournal, settlementInputFromCollection } from './settlement.mjs';

const market={cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS,address:'1'.repeat(32)};
const start=1_700_000_040, maturityAt=start+(HISTORY_MINUTES+5)*60;
const queryHash='a'.repeat(64), queryVersion='1',configVersion='2';
const anchor={graduationPriceAtoms:'1200000',graduationNowQ12:(1440n*Q12).toString(),
  graduation7dQ12:(1440n*Q12).toString(),maxPriceAtoms:'6000000'};
const anchorProvenance={market,slot:'123',signature:'graduation-tx',finality:'finalized'};
const observations=()=>Array.from({length:HISTORY_MINUTES+5},(_,i)=>({
  marketId:market.address,queryVersion,queryHash,bucketStart:start+i*60,bucketEnd:start+(i+1)*60,
  value:{kind:'count',count:'1'},receivedAt:start+(i+1)*60,validatedAt:start+(i+1)*60,
  revision:'0',rawHash:'b'.repeat(64)}));
const input=(rows,now,more={})=>({market,epoch:'17',epochStartedAt:maturityAt-7*86400,
  maturityAt,historyStart:start,now,observations:rows,
  queryVersion,queryHash,configVersion,anchor,anchorProvenance,...more});
const gap=rows=>rows.map((o,i)=>i===rows.length-1?{...o,value:{kind:'missing',reason:'ABSENT_FROM_RESPONSE'}}:o);
const outageAt=maturityAt-60+600;
const outage=lastVerifiedSnapshot=>({startedAt:outageAt,recoveredAt:null,
  provenance:{kind:'PERSISTED_RECOVERY_STATE',dataThrough:maturityAt-60},lastVerifiedSnapshot});

test('normal maturity accepts only T buckets and versions received by T+900',async()=>{
  const rows=observations(),last=rows.at(-1);
  const timely={...last,value:{kind:'count',count:'100'},revision:'1',
    receivedAt:maturityAt+600,validatedAt:maturityAt+600,rawHash:'c'.repeat(64)};
  const late={...last,value:{kind:'count',count:'1000'},revision:'2',
    receivedAt:maturityAt+1200,validatedAt:maturityAt+1200,rawHash:'d'.repeat(64)};
  const afterT={...last,bucketStart:maturityAt,bucketEnd:maturityAt+60,
    value:{kind:'count',count:'100000'},receivedAt:maturityAt+60,validatedAt:maturityAt+60};
  const result=await evaluateSettlement(input([...rows,timely,late,afterT],maturityAt+2000));
  const timelyOnly=await evaluateSettlement(input([...rows,timely],maturityAt+900));
  assert.equal(result.state,'READY');assert.equal(result.candidate.mode,'NORMAL');
  assert.equal(result.candidate.source.dataThrough,maturityAt);
  assert.equal(result.candidate.source.usedVersions.at(-1).revision,'1');
  assert.equal(result.candidate.source.usedVersions.length,rows.length);
  assert.equal(result.candidateHash,timelyOnly.candidateHash);
  assert.equal(result.candidate.source.priceAtoms,timelyOnly.candidate.source.priceAtoms);
  assert.equal((await evaluateSettlement(input(rows,maturityAt+899))).state,'WAITING');
});

test('first complete recovery before original emergency deadline freezes maturity price',async()=>{
  const rows=gap(observations()),last=rows.at(-1);
  const filled={...last,value:{kind:'count',count:'2'},revision:'1',
    receivedAt:maturityAt+1000,validatedAt:maturityAt+1000,rawHash:'c'.repeat(64)};
  const changed={...last,value:{kind:'count',count:'500'},revision:'2',
    receivedAt:maturityAt+1200,validatedAt:maturityAt+1200,rawHash:'d'.repeat(64)};
  assert.equal((await evaluateSettlement(input(rows,maturityAt+900,{outage:outage(null)}))).state,'PENDING_RECOVERY');
  const first=await evaluateSettlement(input([...rows,filled],maturityAt+1000,{outage:outage(null)}));
  const later=await evaluateSettlement(input([...rows,filled,changed],maturityAt+2000,{outage:outage(null)}));
  assert.equal(first.candidate.mode,'RECOVERY');
  assert.equal(first.candidate.acceptedAt,maturityAt+1000);
  assert.equal(first.candidate.source.dataThrough,maturityAt);
  assert.equal(first.candidateHash,later.candidateHash);
  assert.equal(first.candidate.source.usedVersions.at(-1).revision,'1');
  assert.notEqual(first.candidate.source.priceAtoms,
    (await evaluateSettlement(input([...observations(),changed],maturityAt+2000))).candidate.source.priceAtoms);
});

test('unrecovered outage uses finalized last verified price at original 24-hour deadline',async()=>{
  const rows=gap(observations());
  const prior=replay({observations:observations().slice(0,-1),marketId:market.address,queryVersion,queryHash,
    start,end:maturityAt-60,computedAt:maturityAt-60,sequence:'9',configVersion});
  const payload=prior.candidate;
  const [address]=await findSnapshotPda({market:market.address,sequence:BigInt(payload.sequence)},
    {programAddress:market.programId});
  const lastVerifiedSnapshot={payload,payloadHash:hash(payload),chain:{...market,address},
    signature:'published-tx',slot:'777',publishedAt:maturityAt-120,finality:'finalized'};
  const deadline=outageAt+86400;
  const pending=await evaluateSettlement(input(rows,deadline-1,{outage:outage(lastVerifiedSnapshot)}));
  const emergency=await evaluateSettlement(input(rows,deadline,{outage:outage(lastVerifiedSnapshot)}));
  assert.equal(pending.state,'PENDING_RECOVERY');
  assert.equal(emergency.candidate.mode,'EMERGENCY');
  assert.equal(emergency.candidate.acceptedAt,deadline);
  assert.equal(emergency.candidate.source.snapshotRef.payloadHash,lastVerifiedSnapshot.payloadHash);
  assert.equal(emergency.candidate.source.priceAtoms,'1200000');
  const missing=rows.at(-1);
  const atDeadline={...missing,value:{kind:'count',count:'1'},revision:'1',
    receivedAt:deadline,validatedAt:deadline,rawHash:'c'.repeat(64)};
  const tooLate={...atDeadline,receivedAt:deadline+1,validatedAt:deadline+1};
  const recovered=await evaluateSettlement(input([...rows,atDeadline],deadline+1,
    {outage:outage(lastVerifiedSnapshot)}));
  const stillEmergency=await evaluateSettlement(input([...rows,tooLate],deadline+1,
    {outage:outage(lastVerifiedSnapshot)}));
  assert.equal(recovered.candidate.mode,'RECOVERY');
  assert.equal(recovered.candidate.acceptedAt,deadline);
  assert.equal(stillEmergency.candidate.mode,'EMERGENCY');
  await assert.rejects(evaluateSettlement(input(rows,deadline,{outage:outage({...lastVerifiedSnapshot,
    payloadHash:'0'.repeat(64)})})),/EMERGENCY_SNAPSHOT_REQUIRED/);
  await assert.rejects(evaluateSettlement(input(rows,deadline,{outage:outage({...lastVerifiedSnapshot,
    chain:{...lastVerifiedSnapshot.chain,address:market.address}})})),/EMERGENCY_SNAPSHOT_REQUIRED/);
});

test('immediate invalid denominator outage is distinct from stale +600 clock',async()=>{
  const rows=observations().map(o=>({...o,value:{kind:'count',count:'0'}}));
  const result=await evaluateSettlement(input(rows,maturityAt+900,{outage:{startedAt:maturityAt,recoveredAt:null,
    provenance:{kind:'INVALID_SOURCE',invalidatedAt:maturityAt,reason:'INVALID_DENOMINATOR'},
    lastVerifiedSnapshot:null}}));
  assert.equal(result.state,'PENDING_RECOVERY');
  assert.equal(result.emergencyAt,maturityAt+86400);
});

test('24-hour emergency before weekly T closes the epoch without future T activity',async()=>{
  const futureMaturity=maturityAt+3*86400;
  const priorThrough=futureMaturity-2*86400-600;
  const rows=observations();
  for(let t=rows.at(-1).bucketEnd;t<priorThrough;t+=60)
    rows.push({...rows.at(-1),bucketStart:t,bucketEnd:t+60,receivedAt:t+60,validatedAt:t+60});
  const prior=replay({observations:rows,marketId:market.address,queryVersion,queryHash,
    start,end:priorThrough,computedAt:priorThrough,sequence:'10',configVersion});
  const [address]=await findSnapshotPda({market:market.address,sequence:10n},{programAddress:market.programId});
  const snapshot={payload:prior.candidate,payloadHash:hash(prior.candidate),chain:{...market,address},
    signature:'prior-valid',slot:'888',publishedAt:priorThrough,finality:'finalized'};
  const startedAt=priorThrough+600,deadline=startedAt+86400;
  const earlierOutage={startedAt,recoveredAt:null,
    provenance:{kind:'PERSISTED_RECOVERY_STATE',dataThrough:priorThrough},lastVerifiedSnapshot:snapshot};
  const options={maturityAt:futureMaturity,epochStartedAt:futureMaturity-7*86400,
    outage:earlierOutage};
  assert.equal((await evaluateSettlement(input(rows,deadline-1,options))).state,'WAITING');
  const result=await evaluateSettlement(input(rows,deadline,options));
  const delayed=await evaluateSettlement(input(rows,futureMaturity+900,options));
  assert.equal(result.candidate.mode,'EMERGENCY');
  assert(deadline<futureMaturity);
  assert.equal(result.candidate.eligibleAt,deadline);
  assert.equal(result.candidate.effectiveCloseAt,deadline);
  assert.equal(result.candidate.source.dataThrough,priorThrough);
  assert.equal(result.candidateHash,delayed.candidateHash);
  const entry={queryVersion,queryHash,observations:rows,outageTimeline:[]};
  const incident=openOutage(entry,market.address,{startedAt,provenance:earlierOutage.provenance});
  const adapted=await settlementInputFromCollection({store:{read:async()=>({markets:{[market.address]:entry}})},
    market,epoch:'17',epochStartedAt:options.epochStartedAt,maturityAt:futureMaturity,
    historyStart:start,now:deadline,configVersion,anchor,anchorProvenance,
    readLastVerifiedSnapshot:async()=>snapshot});
  const fromJournal=await evaluateSettlement(adapted);
  assert.equal(fromJournal.candidate.outageIncidentId,incident.id);
  assert.equal(fromJournal.candidate.source.priceAtoms,result.candidate.source.priceAtoms);
});

test('journal keeps one market/epoch hash and rejects changed frozen identity',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'ante-settlement-'));
  try{
    const journal=new FileSettlementJournal(join(directory,'settlements.json'));
    const rows=observations();
    const first=await journal.freeze(input(rows,maturityAt+900));
    const later=await new FileSettlementJournal(journal.path).freeze(input([
      ...rows,{...rows.at(-1),value:{kind:'count',count:'900'},revision:'1',
        receivedAt:maturityAt+1200,validatedAt:maturityAt+1200}],maturityAt+2000));
    assert.equal(first.state,'FROZEN_LOCAL');assert.equal(first.candidateHash,later.candidateHash);
    assert.equal(first.frozenAt,maturityAt+900);
    await assert.rejects(journal.freeze(input(rows,maturityAt+2000,{queryVersion:'2'})),
      /SETTLEMENT_IDENTITY_CHANGED/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
