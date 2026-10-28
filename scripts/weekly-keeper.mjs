/** Bounded Devnet weekly settlement driver. At most one Keeper instruction per market/pass. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,mkdir,mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {KitFinalizedAccountReader} from '../services/indexer/src/repositories.ts';
import {FinalizedFinancialAccounts} from '../services/api/src/financial-chain.ts';
import {readFrozenSettlement} from '../services/keeper/src/candidate.ts';

const exec=promisify(execFile);
const kit=createRequire(new URL('../clients/chain/package.json',import.meta.url))('@solana/kit');
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM='FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const monday=now=>Math.floor((now-345_600)/604_800)*604_800+345_600;
const fail=code=>{throw Error(code);};
const asInt=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)fail('WEEKLY_STATE_INVALID');return n;};
const withinState=path=>typeof path==='string'&&path.startsWith('/state/')&&!path.includes('..');
const scrub=message=>String(message).replace(/https?:\/\/[^\s]+/g,'[RPC_REDACTED]').slice(-500);
export const inWeeklyServiceWindow=now=>Number.isSafeInteger(now)&&now>=monday(now)+960&&
  now<=monday(now)+86_400+960;

export function weeklyDue(finance,now){
 if(!Number.isSafeInteger(now)||now<0)fail('WEEKLY_TIME_INVALID');
 const maturity=asInt(finance.currentMaturity),cycle=asInt(finance.currentCycle);
 const last=asInt(finance.lastLpMaturity),open=asInt(finance.openPositions);
 const lpStart=asInt(finance.lpWindowStart),lpEnd=asInt(finance.lpWindowEnd);
 if(cycle<1||lpEnd<lpStart)fail('WEEKLY_STATE_INVALID');
 const week=monday(now);
 if(last>=week&&lpStart>=week)return {due:false,reason:'LP_ALREADY_OPENED'};
 if(maturity>0){
  if(now<maturity+960)return {due:false,reason:'WAIT_FOR_CUTOFF'};
  if(open>0&&now>maturity+86_400)fail('WEEKLY_OBSERVED_DEADLINE_EXCEEDED');
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

export async function runWeeklyPass({now,markets,accounts,env,execute=false,run=command}){
 const output=[];
 for(const market of markets){
  try{
   const finance=await accounts.financeMarket(market.marketId),due=weeklyDue(finance,now);
   if(!due.due){output.push({marketId:market.marketId,state:'idle',reason:due.reason});continue;}
   const active=await resolveWeeklyScope(market,finance,env,run);
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
 if(!inWeeklyServiceWindow(now)&&!args.includes('--preflight'))return;
 const completion={week:monday(now),marketIds:markets.map(m=>m.marketId).sort()};
 const previous=await readJson(config.completionPath).catch(error=>{
  if(error.code==='ENOENT')return null;throw error;
 });
 if(!args.includes('--preflight')&&previous&&exact(previous,completion))return;
 const endpoint=(await readFile(secret,'utf8')).trim();
 if(!/^https:\/\//.test(endpoint)||await kit.createSolanaRpc(endpoint).getGenesisHash().send()!==GENESIS)
  fail('WEEKLY_DEVNET_REQUIRED');
 if(execute&&(!process.env.ANTE_UP_PUBLISHER_KEYPAIR_FILE||!process.env.ANTE_UP_KEEPER_KEYPAIR_FILE))
  fail('WEEKLY_SIGNERS_REQUIRED');
 const accounts=new FinalizedFinancialAccounts({cluster:'devnet',programId:PROGRAM,
  accounts:new KitFinalizedAccountReader(endpoint)});
 const env={...process.env,ANTE_UP_RPC_URL:endpoint};
 const result=await runWeeklyPass({now,markets,accounts,env,execute});
 for(const row of result)console.log(JSON.stringify(row));
 if(execute&&result.every(row=>row.state==='idle'&&row.reason==='LP_ALREADY_OPENED')){
  await mkdir(dirname(config.completionPath),{recursive:true,mode:0o750});
  const temporary=config.completionPath+'.tmp-'+process.pid;
  await writeFile(temporary,JSON.stringify(completion)+'\n',{mode:0o600,flag:'wx'});
  await rename(temporary,config.completionPath);
 }
 if(result.some(row=>row.state==='blocked'||row.state==='unknown'))process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
 main().catch(error=>{console.error(scrub(error?.message));process.exitCode=1;});
