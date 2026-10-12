import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ANTE_UP_PROGRAM_ADDRESS } from '../../clients/chain/dist/index.js';
import { HISTORY_MINUTES } from './index.mjs';
import { FileCollectionState, runInitialArchive, runRegularPoll } from './live.mjs';
import { getAdmissionGateIntent, markSourceInvalid, openOutage, selectOutageForEpoch, updateOutageTimeline,
  validateOutageTimeline } from './outage.mjs';
import { settlementInputFromCollection } from './settlement.mjs';

const start=Math.floor(1_700_000_000/300)*300,end=start+HISTORY_MINUTES*60;
const marketId='fixture:outage';
const rows=(from,through,count=1)=>Array.from({length:(through-from)/60},(_,i)=>({
  start:new Date((from+i*60)*1000).toISOString(),
  end:new Date((from+(i+1)*60)*1000).toISOString(),tweet_count:count}));

test('source-invalid incident survives retry/restart and closes only on validated complete replay',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'ante-outage-'));
  try{
    const store=new FileCollectionState(join(directory,'collection.json'));
    const rawDirectory=join(directory,'raw');
    const common={store,rawDirectory,marketId,expressions:['alpha'],queryVersion:'1',
      estimatedCostMicros:1000};
    const archive=await runInitialArchive({...common,start,through:end,now:end,
      transport:{async count(){return {data:rows(start,end),meta:{}};}}});
    assert.equal(archive.state,'VALIDATED');
    const invalid={async count(){return {data:rows(end,end+300).map((r,i)=>i===2?{...r,tweet_count:-1}:r),meta:{}};}};
    const args={...common,historyStart:start,from:end,through:end+300,transport:invalid};
    assert.equal((await runRegularPoll({...args,now:end+300})).state,'FAILED');
    let saved=await store.read(),incident=saved.markets[marketId].outageTimeline[0];
    assert.equal(incident.startedAt,end+300);
    assert.equal(incident.provenance.reason,'SOURCE_INVALID');
    assert.equal(incident.provenance.rawHash,saved.batches[`${marketId}:1:${end}`].rawHash);
    assert.equal(incident.provenance.batchId,`${marketId}:1:${end}`);
    assert.equal(saved.markets[marketId].recoveryState.emergencyAt,end+300+86400);
    assert.equal(saved.markets[marketId].recoveryState.admission.state,'BLOCKED');
    assert.equal(getAdmissionGateIntent(saved.markets[marketId],marketId).incidentId,incident.id);
    assert.equal(saved.markets[marketId].lastPollAt,end);
    assert.equal(saved.markets[marketId].observations.length,HISTORY_MINUTES);
    assert.equal((await runRegularPoll({...args,now:end+600})).state,'FAILED');
    saved=await new FileCollectionState(store.path).read();
    assert.equal(saved.markets[marketId].outageTimeline.length,1);
    assert.equal(saved.markets[marketId].outageTimeline[0].id,incident.id);
    assert.equal(saved.markets[marketId].outageTimeline[0].startedAt,end+300);
    const valid=await runRegularPoll({...args,now:end+1500,
      transport:{async count(){return {data:rows(end,end+300),meta:{}};}}});
    assert.equal(valid.state,'VALIDATED');
    saved=await store.read();incident=saved.markets[marketId].outageTimeline[0];
    assert.equal(incident.recoveredAt,null);
    assert.equal(saved.markets[marketId].recoveryState.outageStartAt,end+300);
    const complete={candidate:{dataThrough:end+1800,dataStatus:'VALID',reason:null},
      state:{outageStartAt:null,emergencyAt:null}};
    updateOutageTimeline(saved.markets[marketId],marketId,complete,
      {at:end+1800,replayEnd:end+1800,historyStart:start});
    await store.write(saved);
    const reopened=await new FileCollectionState(store.path).read();
    assert.equal(reopened.markets[marketId].outageTimeline[0].recoveredAt,end+1800);
    assert.equal(getAdmissionGateIntent(reopened.markets[marketId],marketId),null);
    assert.equal(reopened.markets[marketId].recoveryState.outageStartAt,null);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('stale/denominator incidents retain their original onset through partial replay',()=>{
  const market={outageTimeline:[],recoveryState:null};
  const stale={candidate:{dataThrough:end,dataStatus:'OUTAGE',reason:'DATA_STALE'},
    state:{outageStartAt:end+600,emergencyAt:end+600+86400}};
  const first=updateOutageTimeline(market,marketId,stale,{at:end+1200,replayEnd:end+600,historyStart:start});
  assert.equal(first.startedAt,end+600);
  const partial={candidate:{dataThrough:end+300,dataStatus:'OUTAGE',reason:'DATA_STALE'},
    state:{outageStartAt:end+300+600,emergencyAt:end+300+600+86400}};
  updateOutageTimeline(market,marketId,partial,{at:end+1500,replayEnd:end+600,historyStart:start});
  assert.equal(market.recoveryState.outageStartAt,end+600);
  assert.equal(market.outageTimeline.length,1);
  const restored=structuredClone(market);
  const complete={candidate:{dataThrough:end+600,dataStatus:'VALID',reason:null},
    state:{outageStartAt:null,emergencyAt:null}};
  updateOutageTimeline(restored,marketId,complete,{at:end+1800,replayEnd:end+600,historyStart:start});
  assert.equal(restored.outageTimeline[0].recoveredAt,end+1800);
  const denominator={candidate:{dataThrough:end+600,dataStatus:'PREPARING',reason:'INVALID_DENOMINATOR'},
    state:{outageStartAt:null,emergencyAt:null}};
  const invalid=updateOutageTimeline(restored,marketId,denominator,
    {at:end+2100,replayEnd:end+600,historyStart:start});
  assert.equal(invalid.provenance.kind,'INVALID_SOURCE');
  assert.equal(invalid.provenance.invalidatedAt,end+2100);
  updateOutageTimeline(restored,marketId,denominator,
    {at:end+2400,replayEnd:end+600,historyStart:start});
  assert.equal(restored.outageTimeline.at(-1).startedAt,end+2100);
  assert.equal(restored.recoveryState.emergencyAt,end+2100+86400);
});

test('collection adapter selects original missed incident and validates journal identity',async()=>{
  const market={cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS,address:'1'.repeat(32)};
  const entry={queryHash:'a'.repeat(64),queryVersion:'1',observations:[],outageTimeline:[]};
  const first=openOutage(entry,market.address,{startedAt:end,
    provenance:{kind:'INVALID_SOURCE',invalidatedAt:end,reason:'SOURCE_INVALID'}});
  first.recoveredAt=end+86460;
  const second=openOutage(entry,market.address,{startedAt:end+90000,
    provenance:{kind:'INVALID_SOURCE',invalidatedAt:end+90000,reason:'SOURCE_INVALID'}});
  const now=end+90010;let requested=null;
  const input=await settlementInputFromCollection({store:{read:async()=>({markets:{[market.address]:entry}})},
    market,epoch:'4',epochStartedAt:end-86400,maturityAt:end+172800,historyStart:start,now,configVersion:'2',
    anchor:{graduationPriceAtoms:'1',graduationNowQ12:'1',graduation7dQ12:'1',maxPriceAtoms:'5'},
    anchorProvenance:{market,slot:'1',signature:'sig',finality:'finalized'},
    readLastVerifiedSnapshot:async({incident})=>{requested=incident.id;return {fixture:true};}});
  assert.equal(input.outage.id,first.id);
  assert.equal(requested,first.id);
  assert.equal(input.outage.lastVerifiedSnapshot.fixture,true);
  assert.equal(entry.outageTimeline[1].id,second.id);
  assert.equal(selectOutageForEpoch(entry,market.address,
    {epochStartedAt:end-86400,maturityAt:end+172800,now}).id,first.id);
  assert.equal(selectOutageForEpoch(entry,market.address,
    {epochStartedAt:end+88000,maturityAt:end+172800,now}).id,second.id);
  const tampered=structuredClone(entry.outageTimeline);
  tampered[0].startedAt++;
  assert.throws(()=>validateOutageTimeline(market.address,tampered),/INVALID_OUTAGE_TIMELINE/);
  assert.equal(markSourceInvalid({outageTimeline:[]},market.address,end).startedAt,end);
  const legacy={recoveryState:{outageStartAt:end+600,emergencyAt:end+600+86400}};
  const reconstructed=selectOutageForEpoch(legacy,market.address,
    {epochStartedAt:end-86400,maturityAt:end+172800,now:end+600+86400});
  assert.equal(reconstructed.startedAt,end+600);
  assert.equal(reconstructed.provenance.dataThrough,end);
  updateOutageTimeline(legacy,market.address,
    {candidate:{dataThrough:end+300,dataStatus:'VALID',reason:null},
      state:{outageStartAt:null,emergencyAt:null}},
    {at:end+1800,replayEnd:end+300,historyStart:start});
  assert.equal(legacy.outageTimeline[0].startedAt,end+600);
  assert.equal(legacy.outageTimeline[0].recoveredAt,end+1800);
});
