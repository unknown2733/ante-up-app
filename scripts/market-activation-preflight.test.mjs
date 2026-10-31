import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectorReadiness,inspectGlobalBudget,lastCollectionRequest,
  preliminaryGraduationGate} from './market-activation-preflight.mjs';
import * as chain from '../clients/chain/dist/index.js';
import {buildQuery} from '../services/data/index.mjs';
import {queryHashFor} from '../services/data/live.mjs';
import {GlobalXBudget} from '../services/data/global-budget.mjs';

const marketId='CyYjBcb4LyuyLN1Akaf2eXXJV5GhFUkaPNb7caLCuHN6';
const seedHex='11'.repeat(32),hash='22'.repeat(32);
const queryHash=queryHashFor(buildQuery(['tariff']));
const config={marketId,seedHex,queryVersion:'1',expressions:['tariff'],
  directory:'/state/tariff',estimatedCostMicros:5000,
  initialEstimatedCostMicros:10000,initialLimitMicros:1000000,
  dailyLimitMicros:1500000,totalLimitMicros:47000000};
const market={id:Buffer.from(seedHex,'hex'),queryHash:Buffer.from(queryHash,'hex'),
  queryVersion:1n,latestSequence:1384n,latestHash:Buffer.from(hash,'hex')};
const registry={schemaVersion:1,maxMarkets:5,markets:[{marketId,seedHex,
  queryHash,queryVersion:'1',candidatePath:'/state/tariff/candidates.json'}]};
const snapshot={payloadHash:Buffer.from(hash,'hex')};
const candidates={snapshots:{[`${marketId}:1384`]:{
  published:{finality:'finalized',payloadHash:hash,
    payload:{marketId,sequence:'1384',queryHash,dataThrough:1000}}}}};
const acceptedSource={status:'LAST_ACCEPTED'};

test('approved collector is ready only when latest finalized candidate matches chain and is fresh',()=>{
  const ready=collectorReadiness({marketId,market,snapshot,registry,config,candidates,
    globalBudget:{status:'READY'},lastSourceRequest:acceptedSource,nowSeconds:1050});
  assert.equal(ready.collectorFeedReady,true);
  assert.deepEqual(ready.collectorBlockers,[]);
  assert.equal(ready.snapshotIdentityMatched,true);
  assert.equal(ready.candidatePath,'/state/tariff/candidates.json');
  assert.equal(collectorReadiness({marketId,market,snapshot,registry,config,candidates,
    globalBudget:{status:'READY'},lastSourceRequest:acceptedSource,nowSeconds:1600}).collectorFeedReady,false);
  const unchecked=collectorReadiness({marketId,market,snapshot,registry,config,candidates,
    globalBudget:{status:'READY'},nowSeconds:1050});
  assert.equal(unchecked.collectorFeedReady,false);
  assert.deepEqual(unchecked.collectorBlockers,['SOURCE_REQUEST_NOT_ACCEPTED']);
});

test('a saved provider cap failure blocks activation even before the snapshot ages out',()=>{
  const earlier=`${marketId}:1:700`,latest=`${marketId}:1:1000`;
  const collection={batches:{
    [earlier]:{id:earlier,state:'VALIDATED'},
    [latest]:{id:latest,state:'FAILED',error:'X_SPEND_CAP_REACHED',retryAt:1300},
    [`backfill:${marketId}:1:1100:1`]:{id:`backfill:${marketId}:1:1100:1`,state:'VALIDATED'},
    ['11111111111111111111111111111111:1:1200']:{id:'11111111111111111111111111111111:1:1200',state:'VALIDATED'}
  }};
  const last=lastCollectionRequest(collection,marketId,'1');
  assert.deepEqual(last,{status:'LAST_SPEND_CAP_FAILURE',from:1000,retryAt:1300});
  const input={marketId,market,snapshot,registry,config,candidates,
    globalBudget:{status:'READY'},lastSourceRequest:acceptedSource,nowSeconds:1050};
  assert.equal(collectorReadiness({...input,lastSourceRequest:last}).latestDataFresh,true);
  assert.equal(collectorReadiness({...input,lastSourceRequest:last}).collectorFeedReady,false);
  assert.deepEqual(collectorReadiness({...input,lastSourceRequest:last}).collectorBlockers,
    ['X_PROVIDER_SPEND_CAP']);
  collection.batches[latest]={id:latest,state:'VALIDATED'};
  const recovered=lastCollectionRequest(collection,marketId,'1');
  assert.deepEqual(recovered,{status:'LAST_ACCEPTED',from:1000,retryAt:null});
  assert.equal(collectorReadiness({...input,lastSourceRequest:recovered}).collectorFeedReady,true);
  assert.equal(collectorReadiness({...input,lastSourceRequest:{status:'MISSING'}}).collectorFeedReady,false);
  assert.throws(()=>lastCollectionRequest({batches:[]},marketId,'1'),/COLLECTION_PREFLIGHT_STATE_INVALID/);
  assert.throws(()=>lastCollectionRequest({batches:{[latest]:{id:'changed',state:'VALIDATED'}}},marketId,'1'),/COLLECTION_PREFLIGHT_STATE_INVALID/);
});

test('graduation preflight cannot become green on an old snapshot during a provider cap',()=>{
  const readyMarket={...market,dataStatus:chain.DataStatus.Valid,
    admission:{state:chain.AdmissionState.Open}};
  const finance={curveSold:1_000_000_000n,curveReserve:1_100_000_000n};
  const input={market:readyMarket,finance,snapshot,paidXApproval:'APPROVED'};
  const green=preliminaryGraduationGate({...input,collection:{collectorFeedReady:true}});
  assert.deepEqual(green.blockers,[]);
  assert.equal(green.fullGraduationPlanStillRequired,true);
  const capped=preliminaryGraduationGate({...input,collection:{collectorFeedReady:false}});
  assert.deepEqual(capped.blockers,['COLLECTOR_FEED_NOT_READY']);
  const uninspected=preliminaryGraduationGate(input);
  assert.deepEqual(uninspected.blockers,['COLLECTOR_FEED_NOT_READY']);
});

test('missing, unfinalized, mismatched, and unapproved candidates cannot be ready',()=>{
  const input={marketId,market,snapshot,registry,config,candidates,
    globalBudget:{status:'READY'},lastSourceRequest:acceptedSource,nowSeconds:1050};
  assert.equal(collectorReadiness({...input,candidates:null}).collectorFeedReady,false);
  assert.equal(collectorReadiness({...input,candidates:{snapshots:{[`${marketId}:1384`]:{
    published:{...candidates.snapshots[`${marketId}:1384`].published,finality:'confirmed'}}}}}).collectorFeedReady,false);
  assert.equal(collectorReadiness({...input,snapshot:{payloadHash:Buffer.alloc(32)}}).collectorFeedReady,false);
  assert.equal(collectorReadiness({...input,registry:{...registry,markets:[]}}).collectorFeedReady,false);
  assert.equal(collectorReadiness({...input,registry:{...registry,markets:[{
    ...registry.markets[0],candidatePath:undefined}]}}).collectorFeedReady,true);
  assert.equal(collectorReadiness({...input,registry:{...registry,markets:[{
    ...registry.markets[0],candidatePath:'/state/other/candidates.json'}]}}).collectorFeedReady,false);
  assert.equal(collectorReadiness({...input,globalBudget:{status:'MISSING'}}).collectorFeedReady,false);
  assert.equal(collectorReadiness({...input,globalBudget:{status:'EXHAUSTED'}}).collectorFeedReady,false);
});

test('existing approved legacy collector is accepted only with the global budget ledger',()=>{
  const legacy={marketId,seedHex,queryVersion:'1',expressions:['tariff'],
    directory:'/state/tariff',estimatedCostMicros:10000};
  const input={marketId,market,snapshot,registry,config:legacy,candidates,nowSeconds:1050};
  assert.equal(collectorReadiness({...input,globalBudget:{status:'READY'},
    lastSourceRequest:acceptedSource}).collectorFeedReady,true);
  assert.equal(collectorReadiness({...input,globalBudget:{status:'MISSING'}}).collectorFeedReady,false);
  assert.throws(()=>collectorReadiness({...input,config:{...legacy,seedHex:'33'.repeat(32)},
    globalBudget:{status:'READY'}}),/CANDIDATE_ONCHAIN_QUERY_MISMATCH/);
});

test('read-only shared budget check distinguishes ledger presence from room for the next poll',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-activation-budget-'));
  try{
    const path=join(dir,'global.sqlite');
    const budget=new GlobalXBudget(path);
    const day='2026-10-30';
    budget.reserve({id:'prior',marketId,day,kind:'regular',costMicros:9_995_000,at:1000});
    const before=budget.totals(day);
    assert.equal(inspectGlobalBudget(path,{day,costMicros:5_000,kind:'regular'}).status,'READY');
    assert.equal(inspectGlobalBudget(path,{day,costMicros:5_001,kind:'regular'}).status,'EXHAUSTED');
    assert.deepEqual(budget.totals(day),before);
    budget.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('initial and total caps also stop new market activation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-activation-limits-'));
  try{
    const path=join(dir,'global.sqlite'),budget=new GlobalXBudget(path);
    const day=index=>new Date(Date.UTC(2026,9,1+index)).toISOString().slice(0,10);
    for(let i=0;i<20;i++)
      budget.reserve({id:`initial-${i}`,marketId,day:day(i),kind:'initial',
        costMicros:5_000_000,at:1000+i});
    assert.equal(inspectGlobalBudget(path,{day:day(20),costMicros:1,kind:'initial'}).status,'EXHAUSTED');
    assert.equal(inspectGlobalBudget(path,{day:day(20),costMicros:1,kind:'regular'}).status,'READY');
    for(let i=20;i<25;i++)
      budget.reserve({id:`regular-${i}`,marketId,day:day(i),kind:'regular',
        costMicros:10_000_000,at:1000+i});
    assert.equal(inspectGlobalBudget(path,{day:day(25),costMicros:1,kind:'regular'}).status,'EXHAUSTED');
    budget.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});
