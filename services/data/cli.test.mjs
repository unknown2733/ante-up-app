import test from 'node:test';
import assert from 'node:assert/strict';
import {latestSettledBucketEnd,requiredLiveConfig,runLiveCycle} from './cli.mjs';

test('X live command fails closed without explicit opt-in, token and cost estimate',()=>{
  assert.throws(()=>requiredLiveConfig({},[]),/LIVE_X_DISABLED/);
  assert.throws(()=>requiredLiveConfig({ANTE_UP_ENABLE_PAID_X:'yes'},['--execute']),/MISSING_X_BEARER_TOKEN/);
  assert.throws(()=>requiredLiveConfig({ANTE_UP_ENABLE_PAID_X:'yes',X_BEARER_TOKEN:'x',
    ANTE_UP_COLLECTION_DIR:'work',ANTE_UP_MARKET_ID:'m',ANTE_UP_EXPRESSIONS_JSON:'["alpha"]',
    ANTE_UP_QUERY_VERSION:'1',ANTE_UP_HISTORY_START:'0',ANTE_UP_X_ESTIMATED_COST_MICROS:'0'},['--execute']),/INVALID_COST_ESTIMATE/);
});

test('X live polling waits one minute after each five-minute bucket closes',()=>{
  const boundary=1_792_245_000;
  assert.equal(latestSettledBucketEnd(boundary),boundary-300);
  assert.equal(latestSettledBucketEnd(boundary+59),boundary-300);
  assert.equal(latestSettledBucketEnd(boundary+60),boundary);
  assert.equal(latestSettledBucketEnd(boundary+299),boundary);
  assert.equal(latestSettledBucketEnd(boundary+300),boundary);
  assert.equal(latestSettledBucketEnd(boundary+360),boundary+300);
});

test('a second poll before the next settled bucket does not call the paid source',async()=>{
  const boundary=1_792_245_000,marketId='test-market';
  let calls=0;
  const result=await runLiveCycle({
    config:{directory:'unused',marketId,expressions:['alpha'],queryVersion:'1',
      historyStart:boundary-28*86400,estimatedCostMicros:500,token:'fixture'},
    argv:['--execute'],now:boundary+30,
    store:{read:async()=>({markets:{[marketId]:{
      recoveryState:{dataThrough:boundary-300},observations:[]}}})},
    transport:{count:async()=>{calls++;throw new Error('PAID_CALL_SHOULD_NOT_HAPPEN');}},
  });
  assert.equal(result.state,'SKIPPED');
  assert.equal(result.reason,'WAIT_FOR_SETTLED_BUCKET');
  assert.equal(calls,0);
});
