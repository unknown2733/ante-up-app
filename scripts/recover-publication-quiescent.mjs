// Operator-only legacy journal repair. No signer, paid source calls or transaction sends.
import {spawn} from 'node:child_process';
import {readFile,mkdir,copyFile,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {hash} from '../services/data/index.mjs';
import {atomicJson,args,check} from './ops/common.mjs';
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM='FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const TARGETS=[{container:'ante-up-collector-1',directory:'live-smoke',market:'7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT'},
  {container:'ante-up-collector-tariff-1',directory:'tariff',market:'CyYjBcb4LyuyLN1Akaf2eXXJV5GhFUkaPNb7caLCuHN6'}];
const dec=x=>typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x);
function validateJob(job){check(job&&['REQUESTING','SUBMITTED'].includes(job.state)&&job.market?.cluster==='devnet'&&
  job.market.programId===PROGRAM&&job.candidate?.marketId===job.market.address&&job.candidate.sequence===job.sequence&&
  dec(job.sequence)&&BigInt(job.sequence)>0n&&hash(job.candidate)===job.candidateHash&&
  (job.state==='REQUESTING'?job.signature===null:typeof job.signature==='string'&&job.signature.length>0),'RECOVERY_JOB_INVALID');}

export async function proveAndExpire({job,producerId,stoppedAt,inspect,captureBoundary,blockTime,finality,readContext,commit,save,
  expire,now=()=>Math.floor(Date.now()/1000),wait=sleep,timeoutSeconds=600}){
  validateJob(job);const originalHash=hash(job),deadline=now()+timeoutSeconds;
  async function stopped(){const p=await inspect();check(p.id===producerId&&!p.running&&!p.restarting,'RECOVERY_PRODUCER_NOT_QUIESCENT');}
  async function pause(){check(now()<deadline,'RECOVERY_WAIT_TIMEOUT');await wait(3000);}
  await stopped();let boundary,time;
  // A returned blockhash may come from a lagging RPC. Require the boundary's
  // block time to be after actual producer stop, not merely after an HTTP call.
  while(true){
    boundary=await captureBoundary();check(boundary.genesisHash===GENESIS&&Number.isSafeInteger(boundary.slot)&&boundary.slot>0&&
      dec(boundary.lastValidBlockHeight)&&typeof boundary.blockhash==='string','RECOVERY_BOUNDARY_INVALID');
    time=await blockTime(boundary.slot);
    while(time===null){await pause();await stopped();time=await blockTime(boundary.slot);}
    if(Number.isSafeInteger(time)&&time>=stoppedAt)break;
    await pause();await stopped();
  }
  const capturedAt=now();await save({stage:'BOUNDARY_CAPTURED',producerId,stoppedAt,boundarySlot:boundary.slot,boundaryBlockTime:time,lastValidBlockHeight:boundary.lastValidBlockHeight});
  let final;
  while(true){
    await stopped();final=await finality(boundary);
    check(Number.isSafeInteger(final.slot)&&final.slot>0&&dec(final.height),'RECOVERY_FINALITY_CONTEXT_INVALID');
    if(final.slot<boundary.slot){await pause();continue;}
    if(BigInt(final.height)>BigInt(boundary.lastValidBlockHeight)&&final.blockhashValid===false)break;
    await pause();
  }
  const context=await readContext(boundary.slot);
  await save({stage:'CHAIN_CONTEXT_READBACK',expected:{sequence:job.sequence,configVersion:job.candidate.configVersion,
    queryVersion:job.candidate.queryVersion,queryHash:job.candidate.queryHash},observed:{
    minContextSlot:context.minContextSlot,snapshotExists:context.snapshotExists,nextSequence:context.nextSequence,
    signaturePresent:context.signatureStatus!==null,configVersion:context.configVersion,
    queryVersion:context.queryVersion,queryHash:context.queryHash}});
  check(context.minContextSlot>=boundary.slot&&context.genesisHash===GENESIS&&context.snapshotExists===false&&
    context.nextSequence===job.sequence&&context.signatureStatus===null&&
    dec(context.configVersion)&&dec(job.candidate.configVersion)&&BigInt(context.configVersion)>=BigInt(job.candidate.configVersion)&&
    context.queryVersion===job.candidate.queryVersion&&
    context.queryHash===job.candidate.queryHash,'RECOVERY_CHAIN_CONTEXT_CHANGED');
  const proof={version:1,kind:'QUIESCENT_RECENT_BLOCKHASH_EXPIRY',marketId:job.market.address,sequence:job.sequence,
    candidateHash:job.candidateHash,originalSignature:job.signature,genesisHash:GENESIS,programId:PROGRAM,
    producerId,producerStopped:true,producerStillStopped:true,producerStoppedAt:stoppedAt,
    capturedAt,verifiedAt:now(),boundaryBlockhash:boundary.blockhash,boundarySlot:String(boundary.slot),boundaryBlockTime:time,
    lastValidBlockHeight:boundary.lastValidBlockHeight,finalizedBlockHeight:final.height,finalizedSlot:String(final.slot),finalizedContextSlot:final.slot,
    boundaryBlockhashValid:false,snapshotExists:false,snapshotAddress:context.snapshotAddress,
    nextSequence:context.nextSequence,signatureStatus:null,readContextSlot:context.minContextSlot,
    candidateConfigVersion:job.candidate.configVersion,configVersion:context.configVersion,
    queryVersion:context.queryVersion,queryHash:context.queryHash};
  const updated=expire(job,proof);await save({stage:'PROVEN_UNLANDED',proof});
  await stopped();await commit(updated,originalHash,proof,stopped);
  await save({stage:'JOURNAL_UPDATED',proof});return proof;
}

async function docker(argv){return new Promise((resolve,reject)=>{
  const p=spawn('docker',argv,{stdio:['ignore','pipe','ignore']});let output='';
  p.stdout.on('data',b=>{output+=b;if(output.length>1000000)p.kill();});p.on('error',()=>reject(Error('DOCKER_COMMAND_FAILED')));
  p.on('close',code=>code===0?resolve(output.trim()):reject(Error('DOCKER_COMMAND_FAILED')));
});}
async function inspect(name){const [id,running,restarting]= (await docker(['inspect','--format','{{.Id}} {{.State.Running}} {{.State.Restarting}}',name])).split(' ');
  check(/^[a-f0-9]{64}$/.test(id),'PRODUCER_ID_INVALID');return {id,running:running==='true',restarting:restarting==='true'};}
export function rpcReader(endpoints,{fetcher=fetch,wait=sleep}={}){return async(method,params=[])=>{
  check(['getGenesisHash','getLatestBlockhash','getBlockTime','getSlot','getBlockHeight','isBlockhashValid',
    'getMultipleAccounts','getAccountInfo','getSignatureStatuses'].includes(method),'RECOVERY_RPC_METHOD_NOT_READ_ONLY');
  const blocked=new Set(),errors=new Map();let pendingBlockTime=false;
  for(let pass=0;pass<3;pass++){
    let retryable=false;
    for(const endpoint of endpoints){
      if(blocked.has(endpoint))continue;
      try{
        const r=await fetcher(endpoint,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(12000),redirect:'error'});
        if(!r.ok){
          await r.body?.cancel();const transient=r.status===429||r.status>=500&&r.status<=599;
          errors.set(endpoint,r.status===429?'RECOVERY_RPC_RATE_LIMITED':transient?'RECOVERY_RPC_UNAVAILABLE':'RECOVERY_RPC_REJECTED');
          if(transient)retryable=true;else blocked.add(endpoint);continue;
        }
        let d;try{d=await r.json();}catch{errors.set(endpoint,'RECOVERY_RPC_INVALID_RESPONSE');blocked.add(endpoint);continue;}
        if(!d.error&&d.result!==undefined)return d.result;
        if(method==='getBlockTime'&&[-32004,-32007,-32009].includes(d.error?.code)){pendingBlockTime=true;blocked.add(endpoint);continue;}
        if(d.error?.code===-32016){errors.set(endpoint,'RECOVERY_RPC_CONTEXT_NOT_READY');retryable=true;continue;}
        errors.set(endpoint,'RECOVERY_RPC_REJECTED');blocked.add(endpoint);
      }catch(e){
        // Only transport failures/timeouts are retried. No provider response text
        // or token-bearing URL is retained in diagnostics.
        if(e?.name==='TimeoutError'||e?.name==='AbortError'||e instanceof TypeError){errors.set(endpoint,'RECOVERY_RPC_UNAVAILABLE');retryable=true;}
        else{errors.set(endpoint,'RECOVERY_RPC_UNAVAILABLE');blocked.add(endpoint);}
      }
    }
    if(!retryable||pass===2)break;
    await wait(pass===0?500:1000);
  }
  if(pendingBlockTime)return null;
  const codes=[...errors.values()];
  throw Error(codes.includes('RECOVERY_RPC_CONTEXT_NOT_READY')?'RECOVERY_RPC_CONTEXT_NOT_READY':
    codes.includes('RECOVERY_RPC_RATE_LIMITED')?'RECOVERY_RPC_RATE_LIMITED':
    codes.includes('RECOVERY_RPC_UNAVAILABLE')?'RECOVERY_RPC_UNAVAILABLE':codes[0]??'RECOVERY_RPC_UNAVAILABLE');
};}

async function main(){
  const a=args(process.argv.slice(2),['--state-root','--rpc-file','--backup-rpc-file','--output'],['--execute']);
  check(a['--state-root']&&a['--rpc-file']&&a['--output'],'RECOVERY_ARGUMENTS_REQUIRED');
  const stateRoot=resolve(a['--state-root']),out=resolve(a['--output']);
  const endpoints=[];for(const path of [a['--rpc-file'],a['--backup-rpc-file']].filter(Boolean)){
    const endpoint=(await readFile(path,'utf8')).trim();const url=new URL(endpoint);check(url.protocol==='https:','RPC_PROTOCOL_INVALID');
    try{const single=rpcReader([endpoint]);check(await single('getGenesisHash')===GENESIS,'RECOVERY_NOT_DEVNET');endpoints.push(endpoint);}catch(e){if(e.message==='RECOVERY_NOT_DEVNET')throw e;}
  }
  check(endpoints.length,'RECOVERY_RPC_UNAVAILABLE');const rpc=rpcReader(endpoints);
  const sdk=await import('../clients/chain/dist/index.js');
  const {expireUnlandedPublication,isPendingPublication}=await import('../services/data/publication-recovery.mjs');
  const work=[];
  for(const target of TARGETS){
    const path=join(stateRoot,target.directory,'candidates.json'),raw=await readFile(path,'utf8'),state=JSON.parse(raw);
    const jobs=Object.values(state.jobs).filter(isPendingPublication);if(!jobs.length)continue;
    check(jobs.length===1&&jobs[0].market.address===target.market,'RECOVERY_PENDING_SET_CHANGED');const job=jobs[0];validateJob(job);
    const [derivedMarket]=await sdk.findMarketPda({marketId:Buffer.from(job.market.seedHex,'hex')});check(derivedMarket===target.market,'RECOVERY_MARKET_PDA_MISMATCH');
    const [snapshotAddress]=await sdk.findSnapshotPda({market:target.market,sequence:BigInt(job.sequence)});
    const [configAddress]=await sdk.findConfigPda();const producer=await inspect(target.container);
    const mounts=JSON.parse(await docker(['inspect','--format','{{json .Mounts}}',target.container]));
    check(mounts.some(m=>m.Destination==='/state'&&resolve(m.Source)===stateRoot),'RECOVERY_PRODUCER_MOUNT_MISMATCH');
    work.push({target,path,state,raw,job,producer,snapshotAddress,configAddress});
  }
  if(!a['--execute']){console.log(JSON.stringify({mode:'PLAN',targets:work.map(w=>({container:w.target.container,jobId:w.job.id,state:w.job.state,snapshotAddress:w.snapshotAddress}))}));return;}
  await mkdir(out,{recursive:true,mode:0o700});const lock=await open(join(out,'recovery.lock'),'wx',0o600);
  const runId=new Date().toISOString().replaceAll(/[:.]/g,'-');await lock.writeFile(runId);await lock.close();
  // Never automatically restart: root verifies the final journals and budgets first.
  for(const w of work){await docker(['stop','--time','30',w.target.container]);w.stoppedAt=Math.ceil(Date.now()/1000);}
  for(const w of work){
    const log=join(out,`${runId}-${w.target.directory}.json`),events=[];
    const save=async event=>{events.push({...event,at:Math.floor(Date.now()/1000)});await atomicJson(log,{version:1,jobId:w.job.id,events});};
    try{await proveAndExpire({job:w.job,producerId:w.producer.id,stoppedAt:w.stoppedAt,inspect:()=>inspect(w.target.container),expire:expireUnlandedPublication,save,
      captureBoundary:async()=>{const r=await rpc('getLatestBlockhash',[{commitment:'processed'}]);return {genesisHash:GENESIS,slot:r.context.slot,blockhash:r.value.blockhash,lastValidBlockHeight:String(r.value.lastValidBlockHeight)};},
      blockTime:slot=>rpc('getBlockTime',[slot]),
      finality:async b=>{const options={commitment:'finalized',minContextSlot:b.slot};
        const slot=await rpc('getSlot',[{commitment:'finalized'}]);if(slot<b.slot)return {slot,height:'0',blockhashValid:true};
        const height=await rpc('getBlockHeight',[options]),valid=await rpc('isBlockhashValid',[b.blockhash,options]);
        check(valid.context.slot>=b.slot,'RECOVERY_FINALITY_CONTEXT_INVALID');return {slot,height:String(height),blockhashValid:valid.value};},
      readContext:async minContextSlot=>{
        const r=await rpc('getMultipleAccounts',[[w.target.market,w.configAddress,w.snapshotAddress],{encoding:'base64',commitment:'finalized',minContextSlot}]);
        check(r.context.slot>=minContextSlot,'RECOVERY_ACCOUNT_CONTEXT_INVALID');const [m,c,s]=r.value;
        check(m?.owner===PROGRAM&&c?.owner===PROGRAM&&!m.executable&&!c.executable,'RECOVERY_ACCOUNT_OWNER_INVALID');
        const mb=Buffer.from(m.data[0],'base64'),cb=Buffer.from(c.data[0],'base64');
        check(mb.subarray(0,8).equals(Buffer.from(sdk.MARKET_DISCRIMINATOR))&&cb.subarray(0,8).equals(Buffer.from(sdk.CONFIG_DISCRIMINATOR)),'RECOVERY_ACCOUNT_DISCRIMINATOR_INVALID');
        const market=sdk.getMarketDecoder().decode(mb),config=sdk.getConfigDecoder().decode(cb);let signatureStatus=null;
        if(w.job.signature){const sr=await rpc('getSignatureStatuses',[[w.job.signature],{searchTransactionHistory:true}]);check(sr.context.slot>=minContextSlot,'RECOVERY_SIGNATURE_CONTEXT_INVALID');signatureStatus=sr.value[0];}
        return {genesisHash:GENESIS,minContextSlot:r.context.slot,snapshotAddress:w.snapshotAddress,snapshotExists:s!==null,
          nextSequence:String(market.latestSequence+1n),signatureStatus,configVersion:String(config.configVersion),queryVersion:String(market.queryVersion),queryHash:Buffer.from(market.queryHash).toString('hex')};},
      commit:async(updated,originalHash,proof,stillStopped)=>{
        check((await readFile(w.path,'utf8'))===w.raw&&hash(w.state.jobs[w.job.id])===originalHash,'RECOVERY_JOURNAL_CHANGED');
        await copyFile(w.path,`${w.path}.quiescent-${runId}.bak`,constants.COPYFILE_EXCL);
        await stillStopped();check((await readFile(w.path,'utf8'))===w.raw,'RECOVERY_JOURNAL_CHANGED');
        w.state.jobs[w.job.id]=updated;await atomicJson(w.path,w.state);
        check(hash(JSON.parse(await readFile(w.path,'utf8')).jobs[w.job.id])===hash(updated),'RECOVERY_JOURNAL_READBACK_FAILED');
      }});
    }catch(e){await save({stage:'STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'RECOVERY_FAILED'});throw e;}
  }
  console.log('QUIESCENT_PUBLICATIONS_RECONCILED_COLLECTORS_REMAIN_STOPPED');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'QUIESCENT_RECOVERY_FAILED');process.exitCode=1;});
