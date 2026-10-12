import test from 'node:test';
import assert from 'node:assert/strict';
import {runKeeperLoop} from '../src/runner.ts';

test('runner never overlaps passes and stops after its bounded count',async()=>{
  let active=0,peak=0;const events:number[]=[];
  const result=await runKeeperLoop({intervalMs:1000,maxPasses:3,maxConsecutiveErrors:2,
    pass:async()=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;return {state:'notDue'};},
    report:e=>events.push(e.pass),sleep:async()=>{}});
  assert.deepEqual(result,{passes:3,errors:0});assert.equal(peak,1);assert.deepEqual(events,[1,2,3]);
});

test('runner backs off and exits on repeated errors',async()=>{
  const delays:number[]=[];const errors:string[]=[];
  await assert.rejects(runKeeperLoop({intervalMs:1000,maxPasses:10,maxConsecutiveErrors:3,
    pass:async()=>{throw Error('RPC unavailable');},report:e=>{if(e.error)errors.push(e.error);},
    sleep:async ms=>{delays.push(ms);}}),/KEEPER_RETRY_LIMIT_REACHED/);
  assert.deepEqual(delays,[1000,2000]);assert.equal(errors.length,3);
});
