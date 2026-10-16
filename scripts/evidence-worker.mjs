// Run behind flock -n -F /state/evidence.lock. One evidence writer; the
// existing indexer is the only projection/cursor writer. No private data logs.
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {ReadOnlyProjection,readJson,durableJson,pendingRecords} from '../services/evidence/worker-support.mjs';
import {reconcileIntake} from '../services/evidence/intake.mjs';
import {heartbeat,checkStorage} from './runtime-status.mjs';
import {ANTE_UP_PROGRAM_ADDRESS} from '../clients/chain/dist/index.js';

const args=process.argv.slice(2),preflight=args.includes('--preflight');
if(args.some(a=>!['--preflight','--once'].includes(a)))throw Error('INVALID_ARGUMENT');
if(!preflight&&(process.env.ANTE_UP_ENABLE_EVIDENCE_LIVE!=='yes'||process.env.ANTE_UP_EVIDENCE_LOCKED!=='yes'))throw Error('EVIDENCE_WORKER_LOCK_REQUIRED');
const directory=process.env.ANTE_UP_LIVE_DIRECTORY;
if(!directory)throw Error('LIVE_DIRECTORY_REQUIRED');
const evidence=join(directory,'evidence'),statePath=join(evidence,'worker.json');
const limit=Number(process.env.ANTE_UP_EVIDENCE_BATCH_SIZE??3);
if(!Number.isInteger(limit)||limit<1||limit>10)throw Error('INVALID_BATCH_SIZE');
const autoDiscover=process.env.ANTE_UP_EVIDENCE_AUTO_DISCOVER==='yes';
const allowlist=autoDiscover?null:process.env.ANTE_UP_EVIDENCE_RECORD_IDS?.split(',')??null;
if(!preflight&&!autoDiscover&&!allowlist?.length)throw Error('EVIDENCE_SCOPE_REQUIRED');
if(allowlist?.some(id=>! /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)))throw Error('INVALID_RECORD_ALLOWLIST');
let stopping=false,child=null,projection;
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopping=true;child?.kill('SIGTERM');});
const detail={state:'STARTING',activeRecord:null,completed:0,held:0,obligations:0,admissionGuard:'NOT_RUN'};
const timer=preflight?null:setInterval(()=>{heartbeat('evidence',detail).catch(()=>{});},15000);
async function run(id,script='scripts/prove-devnet.mjs'){
 return new Promise(resolve=>{
  child=spawn(process.execPath,script==='scripts/prove-devnet.mjs'?
   [script,'--supervised',preflight?'--preflight':'--execute']:[script],{
   env:{...process.env,ANTE_UP_RECORD_ID:id},stdio:['ignore','inherit','inherit'],windowsHide:true});
  const timeout=setTimeout(()=>child?.kill('SIGTERM'),900000);
  child.once('error',()=>{clearTimeout(timeout);child=null;resolve(1);});
  child.once('exit',code=>{clearTimeout(timeout);child=null;resolve(code??1);});
 });
}
try{
 projection=new ReadOnlyProjection(join(directory,'index.sqlite'));
 do{
  const jobs=await readJson(join(evidence,'jobs.json'),{}),now=Math.floor(Date.now()/1000);
  const state=await readJson(statePath,{version:1,attempts:{}});
  const records=projection.records('devnet',ANTE_UP_PROGRAM_ADDRESS);
  if(autoDiscover&&!preflight){
   const path=join(evidence,'intake.json'),prior=await readJson(path,{version:1,obligations:{}});
   const inventory=reconcileIntake(records,jobs,prior,now);
   if(JSON.stringify(inventory)!==JSON.stringify(prior))await durableJson(path,inventory);
   detail.obligations=Object.values(inventory.obligations).filter(x=>x.state!=='LINKED').length;
   // The guard can close on-chain admission but never opens it. A failed gate
   // check is visible while accepted proof obligations continue processing.
   detail.admissionGuard=(await run(null,'scripts/evidence-admission-gate.mjs'))===0?'CHECKED':'UNSAFE';
  }
  if(!preflight)await checkStorage(directory,{existingObligations:autoDiscover});
  const due=pendingRecords(records,jobs,now,{limit:200,allowlist})
   .filter(r=>preflight||!state.attempts[r.id]?.retryAt||state.attempts[r.id].retryAt<=now).slice(0,limit);
  detail.completed=records.filter(r=>r.proofId).length;
  detail.held=Object.values(state.attempts).filter(a=>a.exitCode!==0).length;
  let failedInPass=false;
  for(const record of due){
   if(stopping)break;
   detail.state=preflight?'PREFLIGHT':'PROCESSING';detail.activeRecord=record.id;
   console.log(JSON.stringify({state:detail.state,recordId:record.id}));
   const exitCode=await run(record.id);
   if(exitCode!==0)failedInPass=true;
   if(!preflight){state.attempts[record.id]={at:Math.floor(Date.now()/1000),exitCode,
     retryAt:Math.floor(Date.now()/1000)+(exitCode===0?300:3600)};await durableJson(statePath,state);}
  }
  detail.state=detail.admissionGuard==='UNSAFE'?'ADMISSION_UNSAFE':'WAITING';detail.activeRecord=null;
  if(!preflight)await heartbeat('evidence',detail);
  if(preflight||args.includes('--once')){if(failedInPass)process.exitCode=1;break;}
  // Short sleeps allow graceful stop without accepting another job.
  for(let i=0;i<6&&!stopping;i++)await sleep(10000);
 }while(!stopping);
}catch(error){console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'EVIDENCE_WORKER_FAILED');process.exitCode=1;}
finally{if(timer)clearInterval(timer);projection?.close();}
