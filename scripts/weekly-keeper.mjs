/** Bounded Devnet settlement and validity recovery driver. One instruction per market/pass. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,mkdir,mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {KitFinalizedAccountReader} from '../services/indexer/src/repositories.ts';
import {isRpcRateLimited} from '../services/indexer/src/rpc-retry.ts';
import {FinalizedFinancialAccounts} from '../services/api/src/financial-chain.ts';
import {readFrozenSettlement} from '../services/keeper/src/candidate.ts';
import {FileCollectionState} from '../services/data/live.mjs';
import {selectOutageForEpoch} from '../services/data/outage.mjs';

const exec=promisify(execFile);
const kit=createRequire(new URL('../clients/chain/package.json',import.meta.url))('@solana/kit');
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM='FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const monday=now=>Math.floor((now-345_600)/604_800)*604_800+345_600;
const fail=code=>{throw Error(code);};
const asInt=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)fail('WEEKLY_STATE_INVALID');return n;};
const withinState=path=>typeof path==='string'&&path.startsWith('/state/')&&!path.includes('..');
const scrub=message=>String(message).replace(/https?:\/\/[^\s]+/g,'[RPC_REDACTED]').slice(-500);
/** Select exactly one RPC before any signer is opened. Never switch a signed attempt. */
export async function selectWeeklyRpc(primaryEndpoint,fallbackEndpoint,rpcFactory=kit.createSolanaRpc){
 if(!/^https:\/\//.test(primaryEndpoint))fail('WEEKLY_RPC_URL_INVALID');
 if(fallbackEndpoint&&(!/^https:\/\//.test(fallbackEndpoint)||fallbackEndpoint===primaryEndpoint))
  fail('WEEKLY_FALLBACK_RPC_URL_INVALID');
 const genesis=async endpoint=>rpcFactory(endpoint).getGenesisHash().send();
 try{
  if(await genesis(primaryEndpoint)!==GENESIS)fail('WEEKLY_DEVNET_REQUIRED');
  return {endpoint:primaryEndpoint,source:'primary'};
 }catch(error){
  if(!isRpcRateLimited(error)||!fallbackEndpoint)throw error;
  if(await genesis(fallbackEndpoint)!==GENESIS)fail('WEEKLY_FALLBACK_DEVNET_MISMATCH');
  return {endpoint:fallbackEndpoint,source:'fallback'};
 }
}
export const inWeeklyServiceWindow=now=>Number.isSafeInteger(now)&&now>=monday(now)+960&&
  now<=monday(now)+86_400+960;
// The X publisher runs on five-minute boundaries. Check validity recovery
// two minutes later so a newly finalized snapshot can settle first.
export const inValidityRecoveryTick=now=>Number.isSafeInteger(now)&&now>=0&&
  now%600>=120&&now%600<240;

/** A new validity generation can close Pro after this week's LP window already opened. */
export function validityRecoveryDue(finance,market,now){
 if(!Number.isSafeInteger(now)||now<0||!market)return false;
 const maturity=asInt(finance.currentMaturity),open=asInt(finance.openPositions);
 const shares=BigInt(finance.totalShares),last=asInt(finance.lastLpMaturity);
 const lpEnd=asInt(finance.lpWindowEnd);
 return maturity===0&&open===0&&shares>0&&last===monday(now)&&now>=lpEnd&&
   BigInt(finance.lpGeneration)!==BigInt(market.validityGeneration);
}

export function weeklyDue(finance,now,market=null,settlement=null){
 if(!Number.isSafeInteger(now)||now<0)fail('WEEKLY_TIME_INVALID');
 const maturity=asInt(finance.currentMaturity),cycle=asInt(finance.currentCycle);
 const last=asInt(finance.lastLpMaturity),open=asInt(finance.openPositions);
 const lpStart=asInt(finance.lpWindowStart),lpEnd=asInt(finance.lpWindowEnd);
 if(cycle<1||lpEnd<lpStart)fail('WEEKLY_STATE_INVALID');
 const week=monday(now);
 if(validityRecoveryDue(finance,market,now))return {due:true,reason:'EMPTY_RECOVERY'};
 const accepted=settlement?.value;
 if(maturity>now && accepted && asInt(accepted.maturityAt)===maturity &&
   asInt(accepted.eligibleAt)<maturity && asInt(accepted.acceptedAt)>lpStart)
   return {due:true,reason:'OBSERVED_SETTLEMENT'};
 // An open position may need the documented 24-hour emergency close before
 // the scheduled Monday maturity. This is only a wakeup: the observed
 // collection incident and finalized snapshot must still freeze successfully.
 if(maturity>now && open>0 && market?.latestDataThrough!==undefined){
  const through=asInt(market.latestDataThrough);
  if(through>0 && through<=now && now>=through+600+86_400)
    return {due:true,reason:'OBSERVED_SETTLEMENT'};
 }
 if(last>=week&&lpStart>=week)return {due:false,reason:'LP_ALREADY_OPENED'};
 if(maturity>0){
  if(now<maturity+960)return {due:false,reason:'WAIT_FOR_CUTOFF'};
  // An outage may start as late as the 15-minute observation cutoff. Its
  // 24-hour recovery deadline therefore falls after maturity + 24 hours.
  // Keep the attempt window aligned with inWeeklyServiceWindow instead.
  if(open>0&&now>maturity+86_400+960)fail('WEEKLY_OBSERVED_DEADLINE_EXCEEDED');
  return {due:true,reason:open>0?'OBSERVED_SETTLEMENT':'EMPTY_RECOVERY'};
 }
 if(week<=last||now<week+960)return {due:false,reason:'WAIT_FOR_WEEK'};
 return {due:true,reason:'EMPTY_RECOVERY'};
}

export function validateWeeklyMarkets(raw){
 if(!raw||typeof raw!=='object'||raw.cluster!=='devnet'||raw.programId!==PROGRAM||
   !withinState(raw.completionPath)||!Array.isArray(raw.markets)||raw.markets.length<1||raw.markets.length>5)
  fail('WEEKLY_CONFIG_INVALID');
 const ids=new Set();
 for(const market of raw.markets){
  if(typeof market?.marketId!=='string'||!kit.isAddress(market.marketId)||ids.has(market.marketId)||
    !withinState(market.initialScopePath)||!withinState(market.initialObservedConfigPath)||
    !withinState(market.autoRoot)||market.autoRoot.includes('/cycle-'))fail('WEEKLY_CONFIG_INVALID');
  ids.add(market.marketId);
 }
 return raw.markets;
}

async function command(args,env,timeout=90_000){
 try {const {stdout}=await exec(process.execPath,args,{env,timeout,maxBuffer:1_000_000});
  return JSON.parse(stdout.trim());}
 catch(error){fail(`WEEKLY_COMMAND_FAILED:${scrub(error?.stderr||error?.message)}`);}
}
const exact=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function readJson(path){return JSON.parse(await readFile(path,'utf8'));}

/** New cycle files are published atomically and never overwrite an older scope. */
export async function resolveWeeklyScope(market,finance,env,run=command){
 const root=market.autoRoot,entries=await readdir(root).catch(error=>{
  if(error.code==='ENOENT')return [];throw error;
 });
 const epochs=entries.map(name=>/^cycle-([1-9][0-9]*)$/.exec(name)).filter(Boolean).map(match=>Number(match[1]));
 if(epochs.some(epoch=>!Number.isSafeInteger(epoch)))fail('WEEKLY_SCOPE_INVALID');
 const latest=epochs.length?join(root,`cycle-${Math.max(...epochs)}`):dirname(market.initialScopePath);
 const scopePath=epochs.length?join(latest,'keeper-scope.json'):market.initialScopePath;
 const configPath=epochs.length?join(latest,'observed-config.json'):market.initialObservedConfigPath;
 const previous=await readJson(scopePath),priorConfig=await readJson(configPath);
 if(previous.marketId!==market.marketId||previous.programId!==PROGRAM||previous.cluster!=='devnet'||
   priorConfig.marketId!==market.marketId||priorConfig.epoch!==previous.epoch||
   !/^[1-9][0-9]*$/.test(previous.epoch))fail('WEEKLY_SCOPE_INVALID');
 const current=BigInt(finance.currentCycle),prior=BigInt(previous.epoch);
 if(current===prior)return {directory:latest,scope:previous,scopePath,configPath};
 if(current!==prior+1n||asInt(finance.currentMaturity)===0)fail('WEEKLY_SCOPE_ROTATION_MISMATCH');
 const result=await run(['scripts/prepare-keeper-scope.mjs',market.marketId,scopePath],env);
 const scope=result?.scope;
 if(!scope||scope.epoch!==current.toString()||scope.marketId!==market.marketId||
   scope.maturityAt!==asInt(finance.currentMaturity)||result.cyclePositions<1)fail('WEEKLY_SCOPE_DERIVATION_MISMATCH');
 const nextConfig={...priorConfig,epoch:scope.epoch,maturityAt:scope.maturityAt};
 const destination=join(root,`cycle-${scope.epoch}`);
 await mkdir(root,{recursive:true,mode:0o750});
 const temporary=await mkdtemp(join(root,`.cycle-${scope.epoch}-`));
 try{
  for(const [name,value] of [['keeper-scope.json',scope],['observed-config.json',nextConfig],
    ['settlements.json',{settlements:{}}]])
    await writeFile(join(temporary,name),JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
  await rename(temporary,destination);
 }catch(error){await rm(temporary,{recursive:true,force:true});
  if(error.code!=='EEXIST'&&error.code!=='ENOTEMPTY')throw error;
  if(!exact(await readJson(join(destination,'keeper-scope.json')),scope))fail('WEEKLY_SCOPE_COLLISION');
 }
 return {directory:destination,scope,scopePath:join(destination,'keeper-scope.json'),
  configPath:join(destination,'observed-config.json')};
}

export async function missedObservedDeadline(active,marketId,now,
  readCollection=path=>new FileCollectionState(path).read()){
 const config=await readJson(active.configPath);
 if(!withinState(config.collectionPath)||config.marketId!==marketId)
  fail('WEEKLY_COLLECTION_SCOPE_MISMATCH');
 const collection=await readCollection(config.collectionPath);
 const entry=collection.markets?.[marketId];
 if(!entry)return false;
 const incident=selectOutageForEpoch(entry,marketId,{epochStartedAt:active.scope.epochStartedAt,
   maturityAt:active.scope.maturityAt,now});
 return !!incident && incident.startedAt+86_400<=now &&
   (incident.recoveredAt===null||incident.recoveredAt>incident.startedAt+86_400);
}

export async function runWeeklyPass({now,markets,accounts,env,execute=false,run=command,
  outageDue=missedObservedDeadline}){
 const output=[];
 for(const market of markets){
  try{
   const [finance,chainMarket]=await Promise.all([accounts.financeMarket(market.marketId),accounts.market(market.marketId)]);
   const settlement=asInt(finance.currentMaturity)>now && accounts.settlement?
     await accounts.settlement(market.marketId,finance.currentCycle):null;
   let due=weeklyDue(finance,now,chainMarket,settlement),active=null;
   if(!due.due && asInt(finance.currentMaturity)>now && asInt(finance.openPositions)>0){
    active=await resolveWeeklyScope(market,finance,env,run);
    if(await outageDue(active,market.marketId,now))
      due={due:true,reason:'OBSERVED_SETTLEMENT'};
   }
   if(!due.due){output.push({marketId:market.marketId,state:'idle',reason:due.reason});continue;}
   active??=await resolveWeeklyScope(market,finance,env,run);
   if(BigInt(active.scope.epoch)!==finance.currentCycle)fail('WEEKLY_SCOPE_CYCLE_MISMATCH');
   if(due.reason==='OBSERVED_SETTLEMENT'){
    const frozen=await readFrozenSettlement(join(active.directory,'settlements.json'),active.scope);
    if(!frozen)
      await run(['scripts/prepare-observed-settlement.mjs','freeze',active.directory,active.configPath],env);
   }
   const args=['services/api/src/keeper-run.ts','--scope',active.scopePath,'--journal',join(active.directory,'settlements.json'),
     '--expected-genesis-hash',GENESIS];
   const plan=await run(args,env);
   if(plan.marketId!==market.marketId||plan.epoch!==active.scope.epoch)fail('WEEKLY_PLAN_IDENTITY_MISMATCH');
   if(!execute||plan.action===null){output.push({marketId:market.marketId,state:plan.state,action:plan.action});continue;}
   if(plan.state!=='ready'||!['RECOVER_LP_WINDOW','ACCEPT_SETTLEMENT','SETTLE_PRO','START_LP_WINDOW'].includes(plan.action))
    fail('WEEKLY_PLAN_NOT_READY');
   const sent=await run([...args,'--attempts',join(active.directory,'keeper-attempts.sqlite'),
     '--publisher-keypair',env.ANTE_UP_PUBLISHER_KEYPAIR_FILE,'--keeper-keypair',env.ANTE_UP_KEEPER_KEYPAIR_FILE,
     '--execute'],env);
   if(sent.marketId!==market.marketId||sent.epoch!==active.scope.epoch||sent.action!==plan.action||
     !['submitted','unknown','notDue','complete'].includes(sent.state))fail('WEEKLY_EXECUTION_MISMATCH');
   output.push({marketId:market.marketId,state:sent.state,action:sent.action,signature:sent.signature??null});
  }catch(error){output.push({marketId:market.marketId,state:'blocked',error:scrub(error?.message)});}
 }
 return output;
}

/** Outside the maturity window, only a same-week validity reset may reopen LP. */
export async function runValidityRecoveryPass({now,markets,accounts,env,execute=false,run=command}){
 const output=[];
 for(const market of markets){
  try{
   const [finance,chainMarket]=await Promise.all([accounts.financeMarket(market.marketId),accounts.market(market.marketId)]);
   if(!validityRecoveryDue(finance,chainMarket,now)){
    output.push({marketId:market.marketId,state:'idle',reason:'NO_VALIDITY_RESET'});continue;
   }
   const active=await resolveWeeklyScope(market,finance,env,run);
   if(BigInt(active.scope.epoch)!==finance.currentCycle)fail('WEEKLY_SCOPE_CYCLE_MISMATCH');
   const args=['services/api/src/keeper-run.ts','--scope',active.scopePath,'--journal',join(active.directory,'settlements.json'),
     '--expected-genesis-hash',GENESIS];
   const plan=await run(args,env);
   if(plan.marketId!==market.marketId||plan.epoch!==active.scope.epoch||
      plan.action!=='RECOVER_LP_WINDOW'||plan.state!=='ready')fail('VALIDITY_RECOVERY_PLAN_NOT_READY');
   if(!execute){output.push({marketId:market.marketId,state:'ready',action:plan.action});continue;}
   const sent=await run([...args,'--attempts',join(active.directory,'keeper-attempts.sqlite'),
     '--publisher-keypair',env.ANTE_UP_PUBLISHER_KEYPAIR_FILE,'--keeper-keypair',env.ANTE_UP_KEEPER_KEYPAIR_FILE,
     '--execute'],env);
   if(sent.marketId!==market.marketId||sent.epoch!==active.scope.epoch||sent.action!==plan.action||
     !['submitted','unknown','notDue','complete'].includes(sent.state))fail('VALIDITY_RECOVERY_EXECUTION_MISMATCH');
   output.push({marketId:market.marketId,state:sent.state,action:sent.action,signature:sent.signature??null});
  }catch(error){output.push({marketId:market.marketId,state:'blocked',error:scrub(error?.message)});}
 }
 return output;
}

async function main(){
 const args=process.argv.slice(2),execute=args.includes('--execute');
 if(args.some(arg=>!['--execute','--preflight'].includes(arg))||
   execute&&args.includes('--preflight')||
   execute&&process.env.ANTE_UP_WEEKLY_KEEPER_ENABLED!=='yes')
  fail('WEEKLY_EXECUTION_DISABLED');
 const path=process.env.ANTE_UP_WEEKLY_KEEPER_MARKETS,secret=process.env.ANTE_UP_RPC_URL_FILE;
 if(!withinState(path)||!secret)fail('WEEKLY_CONFIGURATION_INCOMPLETE');
 const config=await readJson(path),markets=validateWeeklyMarkets(config);
 const now=Math.floor(Date.now()/1000);
 const weekly=inWeeklyServiceWindow(now);
 // Cron invokes every two minutes for maturity. Outside that window, check
 // validity resets and 24-hour observed outage deadlines every ten minutes.
 const recoveryTick=inValidityRecoveryTick(now)||args.includes('--preflight');
 if(!weekly&&!recoveryTick)return;
 const completion={week:monday(now),marketIds:markets.map(m=>m.marketId).sort()};
 const previous=await readJson(config.completionPath).catch(error=>{
  if(error.code==='ENOENT')return null;throw error;
 });
 const weeklyComplete=!args.includes('--preflight')&&previous&&exact(previous,completion);
 if(weekly&&weeklyComplete&&!recoveryTick)return;
 const fallbackFile=process.env.ANTE_UP_RPC_FALLBACK_URL_FILE;
 const [primaryEndpoint,fallbackEndpoint]=await Promise.all([
  readFile(secret,'utf8').then(value=>value.trim()),
  fallbackFile?readFile(fallbackFile,'utf8').then(value=>value.trim()):Promise.resolve(null)]);
 const selected=await selectWeeklyRpc(primaryEndpoint,fallbackEndpoint);
 const endpoint=selected.endpoint;
 if(execute&&(!process.env.ANTE_UP_PUBLISHER_KEYPAIR_FILE||!process.env.ANTE_UP_KEEPER_KEYPAIR_FILE))
  fail('WEEKLY_SIGNERS_REQUIRED');
 const accounts=new FinalizedFinancialAccounts({cluster:'devnet',programId:PROGRAM,
  accounts:new KitFinalizedAccountReader(endpoint)});
 const env={...process.env,ANTE_UP_RPC_URL:endpoint,
  ANTE_UP_RPC_URL_FILE:selected.source==='fallback'?fallbackFile:secret};
 const result=weekly&&!weeklyComplete?
   await runWeeklyPass({now,markets,accounts,env,execute}):
   recoveryTick?[
     ...await runWeeklyPass({now,markets,accounts,env,execute}),
     ...await runValidityRecoveryPass({now,markets,accounts,env,execute})
   ]:[];
 for(const row of result)console.log(JSON.stringify(row));
 if(weekly&&!weeklyComplete&&execute&&result.every(row=>row.state==='idle'&&row.reason==='LP_ALREADY_OPENED')){
  await mkdir(dirname(config.completionPath),{recursive:true,mode:0o750});
  const temporary=config.completionPath+'.tmp-'+process.pid;
  await writeFile(temporary,JSON.stringify(completion)+'\n',{mode:0o600,flag:'wx'});
  await rename(temporary,config.completionPath);
 }
 if(result.some(row=>row.state==='blocked'||row.state==='unknown'))process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
 main().catch(error=>{console.error(scrub(error?.message));process.exitCode=1;});
