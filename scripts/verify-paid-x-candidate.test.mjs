import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyCandidate} from './verify-paid-x-candidate.mjs';
import {buildQuery} from '../services/data/index.mjs';

const marketId='CyYjBcb4LyuyLN1Akaf2eXXJV5GhFUkaPNb7caLCuHN6';
const seedHex='c9ab2789eb8c5b6c54611086d77164f07b81f1e4ebb448db15787f9a3915ed32';
const queryHash=createHash('sha256').update(buildQuery(['tariff'])).digest('hex');
const config={marketId,seedHex,expressions:['tariff'],queryVersion:'1',
  estimatedCostMicros:5000,initialEstimatedCostMicros:10000,
  initialLimitMicros:1000000,dailyLimitMicros:1500000,totalLimitMicros:47000000};
const market={id:Buffer.from(seedHex,'hex'),queryHash:Buffer.from(queryHash,'hex'),queryVersion:1n};
const registry={schemaVersion:1,maxMarkets:5,markets:[]};

test('matching finalized market is ready for operator review without approving it',()=>{
  const result=verifyCandidate({marketId,config,market,registry});
  assert.equal(result.state,'READY_FOR_OPERATOR_REVIEW');
  assert.equal(result.approvedCount,0);
  assert.equal(registry.markets.length,0);
});

test('onchain query mismatch cannot pass the review check',()=>{
  assert.throws(()=>verifyCandidate({marketId,
    config:{...config,expressions:['tariffs']},market,registry}),
  /CANDIDATE_ONCHAIN_QUERY_MISMATCH/);
});

test('budget and approval capacity are hard gates',()=>{
  assert.throws(()=>verifyCandidate({marketId,
    config:{...config,dailyLimitMicros:1},market,registry}),/CANDIDATE_BUDGET_INVALID/);
  const full={...registry,markets:Array.from({length:5},(_,i)=>({
    marketId:`${'1'.repeat(31)}${i+1}`,seedHex:`${i+1}`.repeat(64),
    queryHash:`${i+5}`.repeat(64),queryVersion:'1'}))};
  assert.throws(()=>verifyCandidate({marketId,config,market,registry:full}),/PAID_X_APPROVAL_LIMIT/);
});
