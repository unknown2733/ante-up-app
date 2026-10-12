import test from 'node:test';
import assert from 'node:assert/strict';
import {requiredLiveConfig} from './cli.mjs';

test('evidence live command fails closed without explicit opt-in and runtime config',()=>{
  assert.throws(()=>requiredLiveConfig({},[]),/LIVE_EVIDENCE_DISABLED/);
  assert.throws(()=>requiredLiveConfig({ANTE_UP_ENABLE_EVIDENCE_LIVE:'yes'},['--execute']),/MISSING_ANTE_UP_EVIDENCE_JOBS_FILE/);
});
