import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync,cpSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {writeStateJson,readStateJson} from './state-json.mjs';
import {planHistoryArchive,stageHistoryArchive,verifyHistoryArchive,pruneHistoryArchive,validateArchiveManifest} from './history-archive.mjs';
import {measureStateStorage} from '../../scripts/storage-accounting.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'ante-history-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const stateRoot=join(root,'state'),archiveRoot=join(stateRoot,'history-archive'),dir=join(stateRoot,'market');mkdirSync(dir,{recursive:true});mkdirSync(join(stateRoot,'keeper-auto'));
  const collection=join(dir,'collection.json'),candidates=join(dir,'candidates.json');
  writeStateJson(collection,{markets:{m:{observations:[{at:0,count:10}]}}});
  writeStateJson(collection,{markets:{m:{observations:[{at:100,count:12}]}}});
  writeStateJson(candidates,{jobs:{final:{state:'FINALIZED',published:{finality:'finalized'},replayInput:{observations:[{at:10,count:11}],start:10}},
    pending:{state:'SUBMITTED',replayInput:{observations:[{at:20,count:9}],start:20}}}});
  const options={stateRoot,archiveRoot,collections:['market'],protectedPaths:['keeper-auto']};
  const plan=()=>planHistoryArchive(options);
  const restore=()=>{const restored=join(root,'isolated-restore');rmSync(restored,{recursive:true,force:true});cpSync(archiveRoot,restored,{recursive:true});
    return {...verifyHistoryArchive(restored),kind:'HISTORY_ARCHIVE_RESTORE_VERIFICATION'};};
  return {root,stateRoot,archiveRoot,dir,collection,candidates,options,plan,restore};
}
test('archive keeps current and pending nested inputs hot, moves immutable history losslessly and reads old refs',t=>{
  const f=fixture(t),before=JSON.stringify(readStateJson(f.candidates)),plan=f.plan();
  assert.equal(plan.entries.length,3); // orphan observation, finalized replay and its nested observations
  const currentRef=JSON.parse(readFileSync(f.collection)).markets.m.observations.__ante_history_sha256;
  const pendingRef=JSON.parse(readFileSync(f.candidates)).jobs.pending.replayInput.__ante_history_sha256;
  assert.ok(!plan.entries.some(e=>[currentRef,pendingRef].includes(e.contentHash)));
  const staged=stageHistoryArchive(plan,{quiesced:true});assert.equal(staged.entries,3);
  for(const e of plan.entries){assert.equal(readFileSync(join(f.archiveRoot,e.path)).compare(readFileSync(join(f.dir,'.history',`${e.contentHash}.json.gz`))),0);}
  assert.throws(()=>pruneHistoryArchive(plan,staged,{quiesced:true}),/HISTORY_RESTORE_RECEIPT_REQUIRED/);
  const report=pruneHistoryArchive(plan,f.restore(),{quiesced:true});assert.equal(report.removed,3);
  assert.equal(JSON.stringify(readStateJson(f.candidates,f.options)),before);
  assert.ok(existsSync(join(f.dir,'.history',`${currentRef}.json.gz`)));
  assert.ok(existsSync(join(f.dir,'.history',`${pendingRef}.json.gz`)));
  assert.equal(pruneHistoryArchive(plan,f.restore(),{quiesced:true}).removed,0);
});
test('staging and partial-prune restart preserve content and can resume',t=>{
  const f=fixture(t),plan=f.plan();stageHistoryArchive(plan,{quiesced:true});
  assert.deepEqual(stageHistoryArchive(plan,{quiesced:true}),verifyHistoryArchive(f.archiveRoot));
  unlinkSync(join(f.dir,'.history',`${plan.entries[0].contentHash}.json.gz`));
  stageHistoryArchive(plan,{quiesced:true});
  assert.equal(pruneHistoryArchive(plan,f.restore(),{quiesced:true}).removed,plan.entries.length-1);
  assert.equal(readStateJson(f.candidates,f.options).jobs.final.replayInput.start,10);
});
test('changed root, missing protected root and missing historical blob fail closed',t=>{
  const f=fixture(t),plan=f.plan();
  assert.throws(()=>planHistoryArchive({...f.options,protectedPaths:['missing']}),/HISTORY_PROTECTED_PATH_MISSING/);
  writeFileSync(f.collection,JSON.stringify({markets:{}}));
  assert.throws(()=>stageHistoryArchive(plan,{quiesced:true}),/HISTORY_ROOT_CHANGED/);
  const ref=JSON.parse(readFileSync(f.candidates)).jobs.final.replayInput.__ante_history_sha256;
  unlinkSync(join(f.dir,'.history',`${ref}.json.gz`));
  assert.throws(()=>f.plan(),/ENOENT/);
});
test('new roots after planning and source corruption block staging',t=>{
  const f=fixture(t),plan=f.plan();
  writeFileSync(join(f.dir,'new.json'),'{}');assert.throws(()=>stageHistoryArchive(plan,{quiesced:true}),/HISTORY_ROOT_SET_CHANGED/);
  unlinkSync(join(f.dir,'new.json'));writeFileSync(join(f.dir,'.history',`${plan.entries[0].contentHash}.json.gz`),'bad');
  assert.throws(()=>stageHistoryArchive(plan,{quiesced:true}),/HISTORY_SOURCE_CHANGED/);
});
test('active corruption never silently falls back to a valid archive copy',t=>{
  const f=fixture(t),plan=f.plan();stageHistoryArchive(plan,{quiesced:true});
  const ref=JSON.parse(readFileSync(f.candidates)).jobs.final.replayInput.__ante_history_sha256;
  writeFileSync(join(f.dir,'.history',`${ref}.json.gz`),'bad');
  assert.throws(()=>readStateJson(f.candidates,f.options).jobs.final.replayInput);
});
test('archive corruption and wrong restore receipt prevent duplicate removal',t=>{
  const f=fixture(t),plan=f.plan();stageHistoryArchive(plan,{quiesced:true});const receipt=f.restore();
  assert.throws(()=>pruneHistoryArchive(plan,{...receipt,manifestSha256:'0'.repeat(64)},{quiesced:true}),/HISTORY_RESTORE_RECEIPT_REQUIRED/);
  writeFileSync(join(f.archiveRoot,plan.entries[0].path),'bad');
  assert.throws(()=>pruneHistoryArchive(plan,receipt,{quiesced:true}),/HISTORY_ARCHIVE_BYTES_MISMATCH/);
  for(const e of plan.entries)assert.ok(existsSync(join(f.dir,'.history',`${e.contentHash}.json.gz`)));
});
test('unfinished, unknown and falsely-finalized obligations remain hot',t=>{
  const f=fixture(t),v=readStateJson(f.candidates);v.jobs.final.published.finality='confirmed';writeStateJson(f.candidates,v);
  assert.equal(f.plan().entries.length,1);
  v.jobs.final.state='EXPIRED_UNLANDED';v.jobs.final.published.finality='finalized';writeStateJson(f.candidates,v);
  assert.equal(f.plan().entries.length,1);
});
test('protected evidence refs keep exact history active',t=>{
  const f=fixture(t),ref=JSON.parse(readFileSync(f.candidates)).jobs.final.replayInput;
  // Extra active roots in the same namespace resolve the same content-addressed files.
  writeFileSync(join(f.dir,'unsettled.json'),JSON.stringify({input:ref}));
  const plan=planHistoryArchive({...f.options,protectedPaths:['keeper-auto','market/unsettled.json']});
  assert.equal(plan.entries.length,1);
});
test('archive path traversal, duplicate manifest entries and absent quiescence are rejected',t=>{
  const f=fixture(t),plan=f.plan();
  assert.throws(()=>stageHistoryArchive(plan),/HISTORY_WRITERS_MUST_BE_QUIESCED/);
  assert.throws(()=>planHistoryArchive({...f.options,archiveRoot:join(f.dir,'cold')}),/HISTORY_ARCHIVE_IN_ACTIVE_ROOT/);
  assert.throws(()=>validateArchiveManifest({version:1,kind:'HISTORY_ARCHIVE_INVENTORY',entries:[{...plan.entries[0],path:'../x.json.gz'}]}),/HISTORY_ARCHIVE_PATH_INVALID/);
  assert.throws(()=>validateArchiveManifest({version:1,kind:'HISTORY_ARCHIVE_INVENTORY',entries:[plan.entries[0],plan.entries[0]]}),/HISTORY_ARCHIVE_DUPLICATE/);
});
test('active accounting excludes only inventoried cold bytes, counts unknown files, and detects missing entries',async t=>{
  const f=fixture(t),plan=f.plan();stageHistoryArchive(plan,{quiesced:true});pruneHistoryArchive(plan,f.restore(),{quiesced:true});
  const all=await measureStateStorage(f.stateRoot),split=await measureStateStorage(f.stateRoot,f.options);
  assert.equal(all.activeBytes,split.totalBytes);assert.equal(split.totalBytes,split.activeBytes+split.archiveBytes);
  assert.ok(split.archiveBytes>plan.archiveBytes); // includes manifest
  const coldFile=join(f.archiveRoot,'unlisted');writeFileSync(coldFile,'abc');
  assert.equal((await measureStateStorage(f.stateRoot,f.options)).activeBytes,split.activeBytes+3);
  unlinkSync(join(f.archiveRoot,plan.entries[0].path));
  await assert.rejects(measureStateStorage(f.stateRoot,f.options),/HISTORY_ARCHIVE_FILE_MISSING/);
});
test('a new archive can be configured before staging, without hiding any bytes',async t=>{
  const f=fixture(t);mkdirSync(f.archiveRoot);writeFileSync(join(f.archiveRoot,'unknown'),'abc');
  const result=await measureStateStorage(f.stateRoot,f.options);assert.equal(result.archiveBytes,0);
  assert.ok(result.activeBytes>3);
});
