import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {budgetedTransport,journalTransport,pendingRecords,ReadOnlyProjection} from './worker-support.mjs';

test('signed-item reservation survives response loss, restart and day boundary; cap blocks fresh items',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-proof-budget-'));
 try{
  let calls=0,now=Date.parse('2026-10-12T23:59:00Z');const path=join(dir,'budget.json');
  const config={path,totalLimit:'15',dailyLimit:'10',quote:async()=>10,balance:async()=>100,now:()=>now,
   send:async()=>{calls++;if(calls===1)throw Error('response lost');return {id:'accepted'};}};
  const input=text=>({dataItemStreamFactory:()=>Readable.from([Buffer.from(text)])});
  await assert.rejects(()=>budgetedTransport(config)(input('one')),/response lost/);
  assert.equal(Object.values(JSON.parse(await readFile(path))).length,2);
  now+=120000;
  await budgetedTransport(config)(input('one')); // no double reservation
  assert.equal(Object.values(JSON.parse(await readFile(path)).reservations)[0].winc,'10');
  await assert.rejects(()=>budgetedTransport(config)(input('two')),/UPLOAD_BUDGET_EXCEEDED/);
  assert.equal(calls,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('chain signed wire is fsynced before transport and retained on unknown outcome',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-proof-chain-'));
 try{
  const wrapped=journalTransport({async sendTransaction(wire){
   const names=await readdir(dir);const saved=JSON.parse(await readFile(join(dir,names[0])));
   assert.equal(saved.wire,wire);assert.equal(saved.state,'REQUESTING');throw Error('lost');}},dir);
  await assert.rejects(()=>wrapped.sendTransaction('signed-base64'),/lost/);
  assert.equal((await readdir(dir)).length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('record cap uses exact signed-item quotes across restart without charging a shared retry twice',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-proof-record-cap-'));
 try{
  const path=join(dir,'budget.json');let calls=0;
  const config={path,totalLimit:'100',dailyLimit:'100',perRecordLimit:'15',recordId:'record-A',
   quote:async bytes=>bytes,balance:async()=>100,send:async()=>{calls++;return {id:'item'};}};
  const item=text=>({dataItemStreamFactory:()=>Readable.from([Buffer.from(text)])});
  await budgetedTransport(config)(item('1234567890'));
  await budgetedTransport(config)(item('1234567890')); // same signed bytes and reservation
  assert.equal(JSON.parse(await readFile(path,'utf8')).byRecord['record-A'],'10');
  await assert.rejects(()=>budgetedTransport(config)(item('123456')),/UPLOAD_RECORD_BUDGET_EXCEEDED/);
  assert.equal(calls,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('scheduler processes final closed records fairly without blocking on confirming jobs',()=>{
 const records=[1,2,3,4].map(n=>({id:String(n),finality:'finalized',status:'CLOSED_RESULT',exit:{executedAt:n},proofId:null}));
 records.push({...records[0],id:'open',status:'OPEN'});
 records[3].proofId='issued';
 assert.deepEqual(pendingRecords(records,{'proof:1:original':{retryAt:500}},100,{limit:3}).map(r=>r.id),['2','3']);
 assert.deepEqual(pendingRecords(records,{},100,{allowlist:['3']}).map(r=>r.id),['3']);
});

test('proof projection connection cannot mutate SQLite',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-proof-read-'));let reader;
 try{
  const path=join(dir,'index.sqlite'),db=new DatabaseSync(path);
  db.exec('CREATE TABLE current_free_records(cluster,program_id,record_id,record_json);CREATE TABLE current_snapshots(cluster,program_id,snapshot_json);');db.close();
  reader=new ReadOnlyProjection(path);assert.deepEqual(reader.records('devnet','program'),[]);
  assert.throws(()=>reader.db.exec('DELETE FROM current_free_records'),/readonly/);
 }finally{reader?.close();await rm(dir,{recursive:true,force:true});}
});
