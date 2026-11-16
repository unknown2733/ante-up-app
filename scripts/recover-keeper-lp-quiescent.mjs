// Operator-only, no signing dependencies or transaction submission. Default is PLAN.
import {readFileSync,readdirSync,statSync,readlinkSync} from 'node:fs';
import {readFile,mkdir,open} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {hash} from '../services/data/index.mjs';
import {GENESIS,PROGRAM,validateLegacyAttempt,validateBeforeState,validateLegacyExpiry,commitLegacyExpiry} from '../services/keeper/src/legacy-lp-expiry.mjs';
import {rpcReader} from './recover-publication-quiescent.mjs';
import {atomicJson,args} from './ops/common.mjs';
const check=(ok,code)=>{if(!ok)throw Error(code);};
const ROOT='/srv/ante-up/builds/service-state';
const MARKET='CyYjBcb4LyuyLN1Akaf2eXXJV5GhFUkaPNb7caLCuHN6';
const LOCKS=['/srv/ante-up/builds/ops-recovery-20261016/backup-cycle.lock',ROOT+'/keeper-auto/weekly.lock'];
const keeperCommand=s=>/(?:^|[\s/])(weekly-keeper\.mjs|keeper-run\.ts|trial-keeper-execute-one\.sh)(?:\s|$)/.test(s);
export function validateHeldLock({expectedPath,actualPath,fdStat,pathStat,lines,pid}){
 check(actualPath===expectedPath,'KEEPER_EXPIRY_LOCK_PATH');
 check(fdStat.ino===pathStat.ino&&fdStat.dev===pathStat.dev&&lines.some(line=>{
  const p=line.trim().split(/\s+/);return p[1]==='FLOCK'&&p[3]==='WRITE'&&p[4]===String(pid)&&p[5]?.endsWith(':'+fdStat.ino);
 }),'KEEPER_EXPIRY_LOCK_NOT_HELD');
}
function noOtherAttempts(target){
 const config=JSON.parse(readFileSync(ROOT+'/keeper-auto/markets.json','utf8'));
 check(config.cluster==='devnet'&&config.programId===PROGRAM,'KEEPER_EXPIRY_CONFIGURATION_CHANGED');
 const configured=config.markets.filter(m=>m.marketId===MARKET);check(configured.length===1,'KEEPER_EXPIRY_CONFIGURATION_CHANGED');
 const entry=configured[0],host=p=>{
  check(typeof p==='string'&&p.startsWith('/state/'),'KEEPER_EXPIRY_SCOPE_PATH');
  const converted=resolve(ROOT,p.slice(7));check(converted.startsWith(ROOT+'/'),'KEEPER_EXPIRY_SCOPE_PATH');return converted;
 };
 const auto=host(entry.autoRoot),paths=[join(dirname(host(entry.initialScopePath)),'keeper-attempts.sqlite'),
  ...readdirSync(auto).filter(n=>/^cycle-[1-9][0-9]*$/.test(n)).map(n=>join(auto,n,'keeper-attempts.sqlite'))];
 for(const path of new Set(paths)){
  if(path===target)continue;let db;
  try{statSync(path);db=new DatabaseSync(path,{readOnly:true});}
  catch(e){if(e.code==='ENOENT')continue;throw Error('KEEPER_EXPIRY_OTHER_JOURNAL_UNAVAILABLE');}
  try{check(db.prepare("SELECT COUNT(*) n FROM keeper_attempts WHERE market_id=? AND state IN ('UNKNOWN','SUBMITTED')").get(MARKET).n===0,
   'KEEPER_EXPIRY_OTHER_PENDING_ATTEMPT');}finally{db.close();}
 }
}
export function assertHostGuard(){
 check(process.platform==='linux','KEEPER_EXPIRY_HOST_REQUIRED');
 const locks=readFileSync('/proc/locks','utf8').split('\n');
 for(let i=0;i<LOCKS.length;i++){
  const fd=`/proc/self/fd/${8+i}`;
  validateHeldLock({expectedPath:LOCKS[i],actualPath:readlinkSync(fd),fdStat:statSync(fd),pathStat:statSync(LOCKS[i]),lines:locks,pid:process.pid});
 }
 // The lock protects the production runner. Refuse concurrent legacy/manual keeper processes too.
 for(const pid of readdirSync('/proc').filter(n=>/^\d+$/.test(n)&&n!==String(process.pid))){
  let command;try{command=readFileSync(`/proc/${pid}/cmdline`,'utf8').replaceAll('\0',' ');}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')continue;throw Error('KEEPER_EXPIRY_PROCESS_INSPECTION_FAILED');}
  check(!keeperCommand(command),'KEEPER_EXPIRY_PRODUCER_RUNNING');
 }
 let ids;try{ids=execFileSync('docker',['ps','-q'],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);}catch{throw Error('KEEPER_EXPIRY_DOCKER_INSPECTION_FAILED');}
 if(ids.length){
  let containers;try{containers=JSON.parse(execFileSync('docker',['inspect',...ids],{encoding:'utf8',maxBuffer:32*1024*1024}));}catch{throw Error('KEEPER_EXPIRY_DOCKER_INSPECTION_FAILED');}
  for(const c of containers)check(!keeperCommand([...(c.Config.Entrypoint??[]),...(c.Config.Cmd??[])].join(' ')),'KEEPER_EXPIRY_PRODUCER_RUNNING');
 }
 return {weeklyLock:true,backupLock:true,noKeeperProducer:true};
}
export async function proveLegacyLpExpiry({attempt,guard,captureBoundary,blockTime,finality,readState,save,commit,
 now=()=>Math.floor(Date.now()/1000),wait=sleep,timeoutSeconds=600}){
 validateLegacyAttempt(attempt);guard();const stoppedAt=now(),deadline=stoppedAt+timeoutSeconds;
 // A changed state never gets "reconstructed" by guessing missing before fields.
 const before=await readState(0);validateBeforeState(attempt,before.state);
 let boundary,time;
 const pause=async()=>{check(now()<deadline,'KEEPER_EXPIRY_TIMEOUT');await wait(3000);guard();};
 while(true){
  guard();boundary=await captureBoundary();
  check(boundary.genesisHash===GENESIS&&Number.isSafeInteger(boundary.slot)&&boundary.slot>0,'KEEPER_EXPIRY_BOUNDARY_INVALID');
  time=await blockTime(boundary.slot);
  while(time===null){await pause();time=await blockTime(boundary.slot);}
  if(Number.isSafeInteger(time)&&time>=stoppedAt)break;await pause();
 }
 const capturedAt=now();await save({stage:'BOUNDARY_CAPTURED',boundary,stoppedAt,capturedAt,boundaryBlockTime:time});
 let final;
 while(true){
  guard();final=await finality(boundary);
  if(final.slot>=boundary.slot&&BigInt(final.height)>BigInt(boundary.lastValidBlockHeight)&&final.blockhashValid===false)break;
  await pause();
 }
 const after=await readState(final.slot);validateBeforeState(attempt,after.state);guard();
 const proof={kind:'KEEPER_QUIESCENT_LP_EXPIRY',version:1,attemptHash:hash(attempt),programId:PROGRAM,genesisHash:GENESIS,
  recentBlockhashOnly:true,guards:guard(),state:after.state,stoppedAt,capturedAt,verifiedAt:now(),
  boundaryBlockTime:time,boundaryBlockhash:boundary.blockhash,boundarySlot:String(boundary.slot),
  lastValidBlockHeight:boundary.lastValidBlockHeight,finalizedSlot:String(final.slot),accountSlot:String(after.slot),
  finalizedBlockHeight:final.height,blockhashValid:false};
 validateLegacyExpiry(attempt,proof);await save({stage:'PROVEN_UNLANDED',proof});
 guard();const receipt=await commit(attempt,proof,guard);await save({stage:'RECONCILED',receiptHash:receipt});return proof;
}
async function main(){
 const a=args(process.argv.slice(2),['--attempts','--rpc-file','--backup-rpc-file','--output'],['--execute','--reviewed-recent-blockhash-only']);
 check(a['--attempts']&&a['--rpc-file']&&a['--output'],'KEEPER_EXPIRY_ARGUMENTS_REQUIRED');
 const path=resolve(a['--attempts']);
 check(path===ROOT+'/keeper-auto/tariff/cycle-4/keeper-attempts.sqlite','KEEPER_EXPIRY_SCOPE_NOT_APPROVED');
 check(statSync(path).isFile(),'KEEPER_EXPIRY_ATTEMPTS_MISSING');
 if(a['--execute']){
  check(a['--reviewed-recent-blockhash-only']===true,'KEEPER_EXPIRY_TRANSPORT_REVIEW_REQUIRED');
  assertHostGuard();noOtherAttempts(path);
 }
 const db=new DatabaseSync(path,{readOnly:!a['--execute']});
 try{
  const all=db.prepare("SELECT * FROM keeper_attempts WHERE market_id=? AND state IN ('UNKNOWN','SUBMITTED')").all(MARKET);
  check(all.length===1,'KEEPER_EXPIRY_PENDING_SET_CHANGED');const attempt=all[0];validateLegacyAttempt(attempt);
  const endpoints=[];
  for(const file of [a['--rpc-file'],a['--backup-rpc-file']].filter(Boolean)){
   const endpoint=(await readFile(file,'utf8')).trim();check(new URL(endpoint).protocol==='https:','KEEPER_EXPIRY_RPC_PROTOCOL');
   const read=rpcReader([endpoint]);try{check(await read('getGenesisHash')===GENESIS,'KEEPER_EXPIRY_NOT_DEVNET');endpoints.push(endpoint);}catch(e){if(e.message==='KEEPER_EXPIRY_NOT_DEVNET')throw e;}
  }
  check(endpoints.length>0,'KEEPER_EXPIRY_RPC_UNAVAILABLE');const rpc=rpcReader(endpoints);
  const sdk=await import('../clients/chain/dist/index.js');
  const [financeAddress]=await sdk.findFinanceMarketPda({market:MARKET},{programAddress:PROGRAM});
  const readState=async minContextSlot=>{
   const r=await rpc('getMultipleAccounts',[[MARKET,financeAddress],{encoding:'base64',commitment:'finalized',minContextSlot}]);
   check(r.context.slot>=minContextSlot,'KEEPER_EXPIRY_CONTEXT_BEHIND');
   const decode=(a,name)=>{
    check(a?.owner===PROGRAM&&!a.executable,'KEEPER_EXPIRY_ACCOUNT_OWNER');const bytes=Buffer.from(a.data[0],'base64');
    check(bytes.subarray(0,8).equals(Buffer.from(sdk['get'+name+'DiscriminatorBytes']())),'KEEPER_EXPIRY_DISCRIMINATOR');
    return sdk['get'+name+'Decoder']().decode(bytes);
   };
   const m=decode(r.value[0],'Market'),f=decode(r.value[1],'FinanceMarket');check(f.market===MARKET,'KEEPER_EXPIRY_MARKET_MISMATCH');
   return {slot:r.context.slot,state:{marketId:MARKET,cycle:String(f.currentCycle),currentMaturity:Number(f.currentMaturity),
    lpGeneration:String(f.lpGeneration),validityGeneration:String(m.validityGeneration),lastLpMaturity:Number(f.lastLpMaturity),openPositions:f.openPositions}};
  };
  if(!a['--execute']){const s=await readState(0);validateBeforeState(attempt,s.state);console.log(JSON.stringify({mode:'PLAN',attempt,state:s.state,slot:s.slot,requires:'held backup+weekly locks, no keeper producers, post-stop finalized expiry'}));return;}
  check(a['--reviewed-recent-blockhash-only']===true,'KEEPER_EXPIRY_TRANSPORT_REVIEW_REQUIRED');
  const guard=()=>{const result=assertHostGuard();noOtherAttempts(path);return result;};
  guard();const out=resolve(a['--output']);await mkdir(out,{recursive:true,mode:0o700});
  const reservation=await open(join(out,'recovery.lock'),'wx',0o600);await reservation.close();
  const events=[],save=async e=>{events.push({...e,at:Math.floor(Date.now()/1000)});await atomicJson(join(out,'receipt.json'),{version:1,attempt,events});};
  try{await proveLegacyLpExpiry({attempt,guard,readState,save,
   captureBoundary:async()=>{const r=await rpc('getLatestBlockhash',[{commitment:'processed'}]);return {genesisHash:GENESIS,slot:r.context.slot,blockhash:r.value.blockhash,lastValidBlockHeight:String(r.value.lastValidBlockHeight)};},
   blockTime:slot=>rpc('getBlockTime',[slot]),
   finality:async b=>{const slot=await rpc('getSlot',[{commitment:'finalized',minContextSlot:b.slot}]);
    if(slot<b.slot)return {slot,height:'0',blockhashValid:true};
    // Bind expiry height to this specific finalized block, not two unrelated RPC tips.
    const block=await rpc('getBlock',[slot,{commitment:'finalized',transactionDetails:'none',rewards:false}]);
    check(Number.isSafeInteger(block?.blockHeight)&&block.blockHeight>=0,'KEEPER_EXPIRY_BLOCK_UNAVAILABLE');
    const valid=await rpc('isBlockhashValid',[b.blockhash,{commitment:'finalized',minContextSlot:slot}]);
    check(valid.context.slot>=slot,'KEEPER_EXPIRY_CONTEXT_BEHIND');return {slot,height:String(block.blockHeight),blockhashValid:valid.value};},
   commit:(attempt,proof,guard)=>commitLegacyExpiry(db,attempt,proof,guard)});
  }catch(e){await save({stage:'STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'KEEPER_EXPIRY_FAILED'});throw e;}
  console.log('KEEPER_UNSIGNED_LP_ATTEMPT_EXPIRED_NO_TRANSACTION_SENT');
 }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'KEEPER_EXPIRY_FAILED');process.exitCode=1;});
