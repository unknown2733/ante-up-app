import test from 'node:test';
import assert from 'node:assert/strict';
import {requiredLiveConfig} from './cli.mjs';

test('X live command fails closed without explicit opt-in, token and cost estimate',()=>{
  assert.throws(()=>requiredLiveConfig({},[]),/LIVE_X_DISABLED/);
  assert.throws(()=>requiredLiveConfig({ANTE_UP_ENABLE_PAID_X:'yes'},['--execute']),/MISSING_X_BEARER_TOKEN/);
  assert.throws(()=>requiredLiveConfig({ANTE_UP_ENABLE_PAID_X:'yes',X_BEARER_TOKEN:'x',
    ANTE_UP_COLLECTION_DIR:'work',ANTE_UP_MARKET_ID:'m',ANTE_UP_EXPRESSIONS_JSON:'["alpha"]',
    ANTE_UP_QUERY_VERSION:'1',ANTE_UP_HISTORY_START:'0',ANTE_UP_X_ESTIMATED_COST_MICROS:'0'},['--execute']),/INVALID_COST_ESTIMATE/);
});
