import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeCumulativeCoverage} from './reference-coverage-preflight.mjs';

const minute=60_000,cadence=5*minute,now=20*cadence;
const row=(bucket,value)=>({observedAtMs:bucket*cadence+1000,
  capturedAtMs:bucket*cadence+1000,value:String(value),aggregation:'cumulative'});
const options={nowMs:now+1000,windowMs:3*cadence};

test('continuous cumulative readings provide exact interval totals without invented minute rows',()=>{
  const result=analyzeCumulativeCoverage([row(17,100),row(18,102),row(19,102),row(20,109)],options);
  assert.equal(result.status,'SOURCE_COVERAGE_COMPLETE');
  assert.equal(result.observedBuckets,4);
  assert.equal(result.trailingIntervals,3);
});

test('missing source intervals, stale reads and downward revisions stay ineligible',()=>{
  assert.equal(analyzeCumulativeCoverage([row(17,100),row(19,105),row(20,107)],options).missingBuckets,1);
  assert.equal(analyzeCumulativeCoverage([row(17,100),row(18,102),row(19,102),row(20,99)],options).status,'SOURCE_REVISION_DOWN');
  assert.equal(analyzeCumulativeCoverage([row(17,100),row(18,102),row(19,103)],options).status,'SOURCE_HISTORY_INCOMPLETE');
  assert.equal(analyzeCumulativeCoverage([row(17,100),row(18,102),row(19,103),row(20,104)],
    {...options,nowMs:now+3*cadence}).status,'SOURCE_STALE');
});

test('invalid or noncumulative observations cannot be treated as market activity',()=>{
  assert.throws(()=>analyzeCumulativeCoverage([row(20,'-1')],options),/COVERAGE_OBSERVATION_INVALID/);
  assert.throws(()=>analyzeCumulativeCoverage([{...row(20,1),aggregation:'daily'}],options),/COVERAGE_OBSERVATION_INVALID/);
});
