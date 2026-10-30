import test from 'node:test';
import assert from 'node:assert/strict';
import {collectorReadiness} from './market-activation-preflight.mjs';
import {buildQuery} from '../services/data/index.mjs';
import {queryHashFor} from '../services/data/live.mjs';

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

test('approved collector is ready only when latest finalized candidate matches chain and is fresh',()=>{
  const ready=collectorReadiness({marketId,market,snapshot,registry,config,candidates,
    globalBudgetPresent:true,nowSeconds:1050});
  assert.equal(ready.collectorFeedReady,true);
  assert.equal(ready.snapshotIdentityMatched,true);
  assert.equal(ready.candidatePath,'/state/tariff/candidates.json');
  assert.equal(collectorReadiness({marketId,market,snapshot,registry,config,candidates,
    globalBudgetPresent:true,nowSeconds:1600}).collectorFeedReady,false);
});

test('missing, unfinalized, mismatched, and unapproved candidates cannot be ready',()=>{
  const input={marketId,market,snapshot,registry,config,candidates,
    globalBudgetPresent:true,nowSeconds:1050};
  assert.equal(collectorReadiness({...input,candidates:null}).collectorFeedReady,false);
  assert.equal(collectorReadiness({...input,candidates:{snapshots:{[`${marketId}:1384`]:{
    published:{...candidates.snapshots[`${marketId}:1384`].published,finality:'confirmed'}}}}}).collectorFeedReady,false);
  assert.equal(collectorReadiness({...input,snapshot:{payloadHash:Buffer.alloc(32)}}).collectorFeedReady,false);
  assert.equal(collectorReadiness({...input,registry:{...registry,markets:[]}}).collectorFeedReady,false);
  assert.equal(collectorReadiness({...input,registry:{...registry,markets:[{
    ...registry.markets[0],candidatePath:undefined}]}}).collectorFeedReady,true);
  assert.equal(collectorReadiness({...input,registry:{...registry,markets:[{
    ...registry.markets[0],candidatePath:'/state/other/candidates.json'}]}}).collectorFeedReady,false);
  assert.equal(collectorReadiness({...input,globalBudgetPresent:false}).collectorFeedReady,false);
});

test('existing approved legacy collector is accepted only with the global budget ledger',()=>{
  const legacy={marketId,seedHex,queryVersion:'1',expressions:['tariff'],
    directory:'/state/tariff',estimatedCostMicros:10000};
  const input={marketId,market,snapshot,registry,config:legacy,candidates,nowSeconds:1050};
  assert.equal(collectorReadiness({...input,globalBudgetPresent:true}).collectorFeedReady,true);
  assert.equal(collectorReadiness({...input,globalBudgetPresent:false}).collectorFeedReady,false);
  assert.throws(()=>collectorReadiness({...input,config:{...legacy,seedHex:'33'.repeat(32)},
    globalBudgetPresent:true}),/CANDIDATE_ONCHAIN_QUERY_MISMATCH/);
});
