import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceRetryDelaySeconds,isTransientTurboRead,TURBO_READ_EXIT_CODE} from './evidence-retry-policy.mjs';

test('only named non-spending provider reads qualify for short retry',()=>{
  for(const code of ['TURBO_BALANCE_UNAVAILABLE','TURBO_FREE_STATUS_UNAVAILABLE','TURBO_COST_QUOTE_UNAVAILABLE',
    'PARENT_METADATA_TIMEOUT','PARENT_METADATA_UNAVAILABLE','PARENT_BUNDLE_FETCH_TIMEOUT',
    'PARENT_BUNDLE_FETCH_UNAVAILABLE','PARENT_STATUS_TIMEOUT','PARENT_STATUS_UNAVAILABLE'])
    assert.equal(isTransientTurboRead(Error(code)),true);
  for(const code of ['TURBO_UPLOAD_FAILED','SAS_SUBMISSION_UNKNOWN','INVALID_COST_QUOTE',
    'BUNDLE_ROOT_MISMATCH','BUNDLE_CONTENT_MISMATCH','INVALID_RECEIPT','fetch failed'])
    assert.equal(isTransientTurboRead(Error(code)),false);
});

test('successful and transient read attempts retry in five minutes; other failures wait an hour',()=>{
  assert.equal(evidenceRetryDelaySeconds(0),300);
  assert.equal(evidenceRetryDelaySeconds(TURBO_READ_EXIT_CODE),300);
  assert.equal(evidenceRetryDelaySeconds(1),3600);
  assert.equal(evidenceRetryDelaySeconds(137),3600);
});
