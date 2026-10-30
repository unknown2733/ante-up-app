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

test('a rebound after a downward correction is not counted as new activity',()=>{
  const {intervals}=deriveCumulativeIntervals([row(0,100),row(5,95),row(10,98),
    row(15,101),row(20,103)]);
  assert.deepEqual(intervals.map(interval=>[interval.kind,interval.deltaCount]),[
    ['DOWNWARD_REVISION',null],['REVISION_RECOVERY',null],
    ['REVISION_RECOVERY',null],['OBSERVED_DELTA','2']]);
  assert.equal(intervals[1].revisionBaselineCount,'100');
  assert.equal(intervals[2].revisionBaselineCount,'100');
});

test('a downward change hidden inside a missing bucket taints the next interval',()=>{
  const {intervals}=deriveCumulativeIntervals([row(0,100),row(10,95),row(15,97),
    row(20,101),row(25,102)]);
  assert.deepEqual(intervals.map(interval=>interval.kind),[
    'GAP','REVISION_RECOVERY','REVISION_RECOVERY','OBSERVED_DELTA']);
  assert.equal(intervals[1].deltaCount,null);
});

test('a gap that already crossed the pre-correction count permits later adjacent deltas',()=>{
  const {intervals}=deriveCumulativeIntervals([row(0,100),row(5,95),row(15,105),row(20,107)]);
  assert.deepEqual(intervals.map(interval=>[interval.kind,interval.deltaCount]),[
    ['DOWNWARD_REVISION',null],['GAP',null],['OBSERVED_DELTA','2']]);
});

test('rejects invalid cumulative values instead of coercing them',()=>{
  assert.throws(()=>deriveCumulativeIntervals([row(0,'-1')]),/CUMULATIVE_READING_INVALID/);
  assert.throws(()=>deriveCumulativeIntervals([row(0,'1.5')]),/CUMULATIVE_READING_INVALID/);
});
