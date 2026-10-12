import test from 'node:test';
import assert from 'node:assert/strict';
import {replaceJournal} from '../../scripts/atomic-rename.mjs';

test('journal replacement retries transient Windows locks with the same source and target',async()=>{
  let calls=0;const delays=[];
  await replaceJournal('pending','committed',{platform:'win32',wait:async ms=>delays.push(ms),move:async(s,t)=>{
    assert.equal(s,'pending');assert.equal(t,'committed');
    if(++calls<3)throw Object.assign(new Error('locked'),{code:'EPERM'});
  }});
  assert.equal(calls,3);assert.deepEqual(delays,[25,50]);
});
test('journal replacement fails closed after bounded retries or a permanent error',async()=>{
  for(const [platform,code,expected] of [['win32','EPERM',6],['win32','ENOSPC',1],['linux','EPERM',1]]){
    let calls=0;const error=Object.assign(new Error('failed'),{code});
    await assert.rejects(replaceJournal('pending','committed',{platform,wait:async()=>{},move:async()=>{calls++;throw error;}}),e=>e===error);
    assert.equal(calls,expected);
  }
});
