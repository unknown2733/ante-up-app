import test from 'node:test';
import assert from 'node:assert/strict';
import {assert as browser} from '../apps/web/qa/browser/test-runtime.mjs';
test('browser fixture assertions fail on mismatches including missing rejection',async()=>{
  assert.throws(()=>browser.equal(1,2));
  assert.throws(()=>browser.deepEqual({a:1},{a:2}));
  assert.throws(()=>browser.throws(()=>{}));
  await assert.rejects(browser.rejects(Promise.resolve()));
  await assert.rejects(browser.rejects(Promise.reject(Error('other')),/expected/));
  browser.deepEqual({a:[1,2],b:3n},{b:3n,a:[1,2]});
  await browser.rejects(Promise.reject(Error('expected')),/expected/);
});
