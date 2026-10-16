import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFinanceMarketReadiness,type FinanceMarketFacts} from '../src/market-readiness.ts';

const now=1_800_000_000;
function facts():FinanceMarketFacts{return {finality:'finalized',cluster:'devnet',marketId:'observed-market',programId:'program',
  chainNow:now,provenance:'OBSERVED',phase:'CURVE',dataStatus:'VALID',admission:'OPEN',
  latestSequence:'9',latestDataThrough:now-300,queryHash:'a'.repeat(64),queryVersion:'1',latestHash:'b'.repeat(64),
  snapshot:{sequence:'9',payloadHash:'b'.repeat(64),queryHash:'a'.repeat(64),queryVersion:'1'},
  activityNowQ12:'120000000000000',activity7dQ12:'100000000000000',
  finance:{curveSold:'1000000000',curveReserve:'1100000000',marketFees:'0',assets:'1150000000',
    externalQ:'0',anchorPg:'0',anchorSg:'0',anchorDg:'0',pmax:'0',proReserved:'0',otherReserved:'0',
    openPositions:0,totalShares:'0',lockedShares:'0',currentCycle:'0',currentMaturity:0,
    lpWindowStart:0,lpWindowEnd:0,proReopenAt:0,lastLpMaturity:0,lpGeneration:'0',validityGeneration:'0'},
  support:{supportedMarkets:0,supportSpent:'0',supportPaymentBalance:'50000000000'},
  keeper:{scopePresent:false,scopeMatches:false,publisherKeyPresent:false,keeperKeyPresent:false,
    attemptsStorePresent:false,candidateFrozen:false}};}

test('graduation needs actual curve cap, observed fresh snapshot and funded support',()=>{
  const ready=evaluateFinanceMarketReadiness(facts());
  assert.equal(ready.graduation.eligible,true);assert.equal(ready.status,'READY_FOR_REVIEW');
  assert.equal(ready.graduation.requiredContribution,'7350000000');
  for(const [change,code] of [
    [(f:FinanceMarketFacts)=>{f.finance.curveSold='999000000';},'CURVE_CAP_NOT_REACHED'],
    [(f:FinanceMarketFacts)=>{f.latestDataThrough=now-600;},'DATA_STALE_OR_FUTURE'],
    [(f:FinanceMarketFacts)=>{f.snapshot!.payloadHash='c'.repeat(64);},'SNAPSHOT_IDENTITY_UNVERIFIED'],
    [(f:FinanceMarketFacts)=>{f.provenance='SYNTHETIC';},'SOURCE_NOT_VERIFIED_OBSERVED'],
    [(f:FinanceMarketFacts)=>{f.support.supportPaymentBalance='1';},'ACTUAL_SUPPORT_BALANCE_INSUFFICIENT'],
    [(f:FinanceMarketFacts)=>{f.support.supportPaymentBalance=null;},'ACTUAL_SUPPORT_BALANCE_INSUFFICIENT'],
    [(f:FinanceMarketFacts)=>{f.support.supportSpent='49000000000';},'SUPPORT_BUDGET_INSUFFICIENT'],
    [(f:FinanceMarketFacts)=>{f.finance.assets='1';},'CURVE_ASSETS_BELOW_LIABILITIES']
  ] as const){const f=facts();change(f);assert.ok(evaluateFinanceMarketReadiness(f).graduation.blockers.includes(code),code);}
});

test('indexed trading keeps spot maximum, Pro and fixed-debt reserves behind buffer',()=>{
  const f=facts();f.phase='INDEXED';f.finance={...f.finance,externalQ:'1000000000',assets:'8000000000',
    anchorPg:'1200000',anchorSg:'120000000000000',anchorDg:'100000000000000',pmax:'5000000',
    proReserved:'1000000000',otherReserved:'200000000',totalShares:'6000000000',lockedShares:'6000000000',
    lpWindowStart:now-100,lpWindowEnd:now+800,lastLpMaturity:now-1000};
  const ready=evaluateFinanceMarketReadiness(f);
  assert.equal(ready.indexed.spotReserve,'5000000000');
  assert.equal(ready.indexed.freeCapital,'1300000000');
  assert.equal(ready.indexed.epoch,'INITIAL_LP');
  assert.equal(ready.indexed.eligible,true);
  f.finance.otherReserved='1800000000';
  const blocked=evaluateFinanceMarketReadiness(f);
  assert.equal(blocked.indexed.freeCapital,'-300000000');
  assert.ok(blocked.indexed.blockers.includes('RESERVE_BUFFER_OR_FIXED_DEBT_UNFUNDED'));
});

test('weekly maturity requires exact keeper scope, durable attempts and frozen candidate',()=>{
  const f=facts();f.phase='INDEXED';f.finance={...f.finance,externalQ:'0',assets:'5000000000',
    anchorPg:'1200000',anchorSg:'120000000000000',anchorDg:'100000000000000',pmax:'5000000',
    totalShares:'4500000000',lockedShares:'4500000000',currentCycle:'2',currentMaturity:now-30,
    openPositions:1};
  f.keeper={scopePresent:true,scopeMatches:true,publisherKeyPresent:true,keeperKeyPresent:true,
    attemptsStorePresent:true,candidateFrozen:true};
  const result=evaluateFinanceMarketReadiness(f);
  assert.equal(result.indexed.epoch,'SETTLING');assert.equal(result.maturity.eligible,true);
  f.latestDataThrough=now-10_000;
  assert.ok(evaluateFinanceMarketReadiness(f).indexed.blockers.includes('DATA_STALE_OR_FUTURE'));
  assert.equal(evaluateFinanceMarketReadiness(f).maturity.eligible,true,'historical frozen maturity does not use latest price');
  f.keeper.candidateFrozen=false;
  assert.ok(evaluateFinanceMarketReadiness(f).maturity.blockers.includes('FROZEN_MATURITY_CANDIDATE_MISSING'));
  f.keeper.candidateFrozen=true;f.provenance='UNKNOWN';
  assert.ok(evaluateFinanceMarketReadiness(f).maturity.blockers.includes('SOURCE_NOT_VERIFIED_OBSERVED'));
});
