import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileJobRepository,payloadHash} from './index.mjs';
import {reconcileCompletion} from './completion.mjs';
import {evidenceWorkSummary,isCompletionPending,shouldReconcileCompletion} from './worker-support.mjs';
import {evidenceRetryDelaySeconds} from '../../scripts/evidence-retry-policy.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('finalized read reconciliation preserves uncertain submission and exact proof evidence across restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'completion-')),path=join(dir,'jobs.json');
 try{
  const payload={record:{id:'record'},evidence:[]},hash=payloadHash(payload);
  const job={id:'proof:record:original',recordId:'record',record:{id:'record'},state:'ISSUED',sasId:'sas',payloadHash:hash,payload,
   manifestRef:{arweaveItemId:'manifest'},artifacts:[],sasSubmission:{state:'REQUESTING'},completion:{state:'SUBMITTED',signature:'sig'}};
  await new FileJobRepository(path).write({[job.id]:job});
  const verified={recordId:'record',proofHash:hash,sasId:'sas'};
  assert.deepEqual(await reconcileCompletion(path,verified),{state:'FINALIZED',signature:'sig'});
  const saved=(await new FileJobRepository(path).read())[job.id];
  assert.deepEqual(saved,{...job,completion:{state:'FINALIZED',signature:'sig'}});
  const before=await readFile(path,'utf8');
  await reconcileCompletion(path,verified);assert.equal(await readFile(path,'utf8'),before);
  for(const change of [{proofHash:'0'.repeat(64)},{sasId:'other'},{recordId:'other'}]){
   await assert.rejects(()=>reconcileCompletion(path,{...verified,...change}),/COMPLETION_RECONCILE_CONFLICT/);
   assert.equal(await readFile(path,'utf8'),before);
  }
  saved.state='INVALID';await new FileJobRepository(path).write({[job.id]:saved});
  await assert.rejects(()=>reconcileCompletion(path,verified),/COMPLETION_RECONCILE_CONFLICT/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('completion-write CLI refuses to run outside the sole locked worker',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../../scripts/verify-devnet-proof.mjs',import.meta.url)),'--reconcile-completion'],
  {env:{...process.env,ANTE_UP_EVIDENCE_LOCKED:''},encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,/EVIDENCE_WORKER_LOCK_REQUIRED/);
});

test('health counts current unfinished duties while retaining historical failure receipts',()=>{
 const record=(id,proofId=null)=>({id,proofId,finality:'finalized',status:'CLOSED_NA',exit:{executedAt:1}});
 const records=[record('archived','proof:archived:original'),record('done','proof:done:original'),
  record('sync','proof:sync:original'),record('upload'),record('invalid')];
 const jobs={'proof:done:original':{state:'ISSUED',completion:{state:'FINALIZED'}},
  'proof:sync:original':{state:'ISSUED',completion:{state:'SUBMITTED'}},'proof:invalid:original':{state:'INVALID'}};
 const attempts={archived:{exitCode:1},done:{exitCode:1},sync:{exitCode:0},upload:{exitCode:1},invalid:{exitCode:1},orphan:{exitCode:1}};
 const before=JSON.stringify(attempts);
 assert.deepEqual(evidenceWorkSummary(records,jobs,attempts),{completed:2,obligations:3,held:2});
 assert.equal(JSON.stringify(attempts),before);
 assert.equal(isCompletionPending(jobs['proof:sync:original']),true);
 assert.equal(isCompletionPending(jobs['proof:done:original']),false);
 assert.equal(evidenceRetryDelaySeconds(0,{completionPending:true}),60);
 assert.equal(evidenceRetryDelaySeconds(1,{completionPending:true}),3600);
 assert.equal(evidenceRetryDelaySeconds(0,{completionPending:false}),300);
 const lag=[record('lag')],lagJob={'proof:lag:original':{state:'ISSUED',completion:{state:'FINALIZED'}}};
 assert.deepEqual(evidenceWorkSummary(lag,lagJob,{lag:{exitCode:1}}),{completed:0,obligations:1,held:0});
});

test('routing distinguishes SAS-only crash recovery from an uncertain completion submission',()=>{
 for(const completion of [undefined,{state:'PREPARED'}]){
  const job={state:'ISSUED',completion};assert.equal(isCompletionPending(job),true);
  assert.equal(shouldReconcileCompletion(job),false);
 }
 for(const state of ['REQUESTING','SUBMITTED'])assert.equal(shouldReconcileCompletion({state:'ISSUED',completion:{state}}),true);
 assert.equal(shouldReconcileCompletion({state:'ISSUED',completion:{state:'FINALIZED'}}),false);
 assert.equal(shouldReconcileCompletion({state:'INVALID',completion:{state:'REQUESTING'}}),false);
});
