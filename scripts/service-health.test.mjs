import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
test('controlled source wait reports liveness without accepting stale or unknown heartbeats',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-health-'));
 try{for(const [data,expected] of [
  [{role:'collector',at:Date.now(),state:'WAITING',reason:'PUBLICATION_PENDING'},0],
  [{role:'collector',at:Date.now(),state:'WAITING',reason:'STATE_STORAGE_LIMIT'},0],
  [{role:'collector',at:Date.now()-200000,state:'WAITING',reason:'RPC_RATE_LIMITED'},1],
  [{role:'collector',at:Date.now(),state:'WAITING',reason:'UNKNOWN'},1],
  [{role:'collector',at:Date.now(),lastPollAt:1},1]]){
   await writeFile(join(dir,'collector.json'),JSON.stringify(data));
   assert.equal(spawnSync(process.execPath,['scripts/service-health.mjs','collector'],{env:{...process.env,ANTE_UP_HEALTH_DIRECTORY:dir}}).status,expected);
 }}finally{await rm(dir,{recursive:true,force:true});}
});
