import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readStateJson,writeStateJson} from './state-json.mjs';
test('legacy histories migrate losslessly, deduplicate, stay lazy, and preserve mutation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ante-state-'));
 try{
  const p=join(dir,'state.json'),observations=Array.from({length:1000},(_,i)=>({at:i,count:i%9}));
  const input={spentByDay:{today:10000},markets:{a:{observations}},jobs:{one:{replayInput:{observations,start:0}},two:{replayInput:{observations,start:0}}}};
  writeFileSync(p,JSON.stringify(input));assert.deepEqual(readStateJson(p),input);
  writeStateJson(p,readStateJson(p));assert.ok(readFileSync(p).length<1000);
  assert.equal(readdirSync(join(dir,'.history')).length,2);
  assert.deepEqual(JSON.parse(JSON.stringify(readStateJson(p))),input);
  const next=readStateJson(p);next.markets.a.observations.push({at:1000,count:10});writeStateJson(p,next);
  assert.equal(readStateJson(p).markets.a.observations.length,1001);
  assert.equal(readStateJson(p).jobs.one.replayInput.observations.length,1000);
  const fresh=readStateJson(p); const jobRef=JSON.parse(readFileSync(p)).jobs.one.replayInput.__ante_history_sha256;
  writeFileSync(join(dir,'.history',`${jobRef}.json.gz`),'corrupted');
  writeStateJson(p,fresh); // routine writes do not inflate unrelated old histories
  assert.throws(()=>fresh.jobs.one.replayInput);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
