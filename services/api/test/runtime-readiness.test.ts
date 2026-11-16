import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readRuntimeReadiness} from '../src/runtime-readiness.ts';

test('only fresh, matching collector diagnostics reach the public market',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'readiness-'));const now=1800000000;
 const report={role:'collector',marketId:'market-a',at:now*1000-500,state:'WAITING',reason:'STATE_STORAGE_LIMIT',privateDetail:'must not leak'};
 const save=async(value:unknown)=>writeFile(join(dir,'collector.json'),JSON.stringify(value));
 try{
  assert.equal(await readRuntimeReadiness(dir,'market-a',now),undefined);
  await save(report);
  assert.deepEqual(await readRuntimeReadiness(dir,'market-a',now),{reason:'STORAGE_PRESSURE',checkedAt:now-1});
  assert.equal(await readRuntimeReadiness(dir,'market-b',now),undefined);
  for(const update of [{at:now*1000-180001},{at:(now+1)*1000},{role:'other'},{state:'COLLECTED'},{reason:'unexpected'}]){
   await save({...report,...update});assert.equal(await readRuntimeReadiness(dir,'market-a',now),undefined);
  }
  await writeFile(join(dir,'collector.json'),'{');assert.equal(await readRuntimeReadiness(dir,'market-a',now),undefined);
  await save({...report,at:now*1000+500,reason:'PUBLICATION_PENDING'});
  assert.deepEqual(await readRuntimeReadiness(dir,'market-a',now),{reason:'PUBLICATION_PENDING',checkedAt:now});
  await writeFile(join(dir,'collector-tariff.json'),JSON.stringify({...report,role:'collector-tariff',at:now*1000,reason:'RPC_RATE_LIMITED'}));
  assert.equal((await readRuntimeReadiness(dir,'market-a',now))?.checkedAt,now);
 }finally{await rm(dir,{recursive:true,force:true});}
});
