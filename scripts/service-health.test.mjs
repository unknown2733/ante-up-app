import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
import {checkHttpHealth} from './service-health.mjs';

test('API Docker health requests only lightweight liveness and rejects malformed or non-live replies',async()=>{
 const valid={service:'ante-up-api',kind:'liveness',status:'ok',mode:'devnet',cluster:'devnet',configurationReady:true};
 const calls=[];
 await checkHttpHealth('api',async url=>{calls.push(url);return Response.json(valid);});
 assert.deepEqual(calls,['http://127.0.0.1:8787/health']);
 for(const body of [null,{}, {mode:'devnet'}, {...valid,mode:'fixture'}, {...valid,cluster:'localnet'},
  {...valid,status:'error'}, {...valid,kind:'readiness'}, {...valid,service:'other'}, {...valid,configurationReady:false}])
  await assert.rejects(checkHttpHealth('api',async()=>Response.json(body)),/API_LIVENESS_INVALID/);
 await assert.rejects(checkHttpHealth('api',async()=>new Response('bad json')));
 await assert.rejects(checkHttpHealth('api',async()=>Response.json(valid,{status:503})),/HTTP_HEALTH_FAILED/);
 await assert.rejects(checkHttpHealth('api',async()=>{throw Error('connection refused');}),/connection refused/);
});

test('web liveness remains an HTTP root check',async()=>{
 const urls=[];await checkHttpHealth('web',async url=>{urls.push(url);return new Response('web');});
 assert.deepEqual(urls,['http://127.0.0.1:8080/']);
});
test('controlled source wait reports liveness without accepting stale or unknown heartbeats',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-health-'));
 try{for(const [data,expected] of [
  [{role:'collector',at:Date.now(),state:'WAITING',reason:'PUBLICATION_PENDING'},0],
  [{role:'collector',at:Date.now(),state:'WAITING',reason:'STATE_STORAGE_LIMIT'},0],
  [{role:'collector',state:'WAITING',reason:'PUBLICATION_PENDING'},1],
  [{role:'collector',at:Date.now()+100000,state:'WAITING',reason:'PUBLICATION_PENDING'},1],
  [{role:'collector',at:Date.now()-200000,state:'WAITING',reason:'RPC_RATE_LIMITED'},1],
  [{role:'collector',at:Date.now(),state:'WAITING',reason:'UNKNOWN'},1],
  [{role:'collector',at:Date.now(),lastPollAt:1},1]]){
   await writeFile(join(dir,'collector.json'),JSON.stringify(data));
   assert.equal(spawnSync(process.execPath,['scripts/service-health.mjs','collector'],{env:{...process.env,ANTE_UP_HEALTH_DIRECTORY:dir}}).status,expected);
 }}finally{await rm(dir,{recursive:true,force:true});}
});
