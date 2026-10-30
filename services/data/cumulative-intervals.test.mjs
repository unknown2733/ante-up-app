import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveCumulativeIntervals} from './cumulative-intervals.mjs';

const row=(minute,value,rawSha256)=>({observedAtMs:minute*60_000,
  capturedAtMs:minute*60_000,value:String(value),rawSha256});

test('preserves actual irregular sample times and evidence for an adjacent bucket delta',()=>{
  const {intervals}=deriveCumulativeIntervals([row(0,100,'a'),row(5,104,'b'),
    {...row(5,105,'c'),observedAtMs:5*60_000+20_000,capturedAtMs:5*60_000+20_000}]);
  assert.deepEqual(intervals,[{kind:'OBSERVED_DELTA',fromAtMs:0,toAtMs:320_000,
    durationMs:320_000,deltaCount:'5',fromRawSha256:'a',toRawSha256:'c'}]);
});

test('gaps and provider downward revisions never become activity counts',()=>{
  const {intervals}=deriveCumulativeIntervals([row(0,100),row(10,110),row(15,107)]);
  assert.equal(intervals[0].kind,'GAP');
  assert.equal(intervals[0].deltaCount,null);
  assert.equal(intervals[1].kind,'DOWNWARD_REVISION');
  assert.equal(intervals[1].deltaCount,null);
  assert.equal(intervals[1].revisionMagnitude,'3');
});

test('rejects invalid cumulative values instead of coercing them',()=>{
  assert.throws(()=>deriveCumulativeIntervals([row(0,'-1')]),/CUMULATIVE_READING_INVALID/);
  assert.throws(()=>deriveCumulativeIntervals([row(0,'1.5')]),/CUMULATIVE_READING_INVALID/);
});
