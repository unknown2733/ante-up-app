import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {weeklyDue,inWeeklyServiceWindow,inValidityRecoveryTick,validityRecoveryDue,validateWeeklyMarkets,resolveWeeklyScope,
  runWeeklyPass,runValidityRecoveryPass} from './weekly-keeper.mjs';

const program='FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const marketId='CyYjBcb4LyuyLN1Akaf2eXXJV5GhFUkaPNb7caLCuHN6';
const week=1793577600;
const finance=(overrides={})=>({currentCycle:3n,currentMaturity:BigInt(week),
  lastLpMaturity:BigInt(week-604800),lpWindowStart:0n,lpWindowEnd:0n,openPositions:0,
  totalShares:100n,lpGeneration:1n,...overrides});
const chainMarket={validityGeneration:1n};
const anchor={graduationPriceAtoms:'1200000',graduationNowQ12:'20',graduation7dQ12:'10',maxPriceAtoms:'7474059'};
const scope={cluster:'devnet',programId:program,marketId,epoch:'3',epochStartedAt:week-300000,
  maturityAt:week,queryHash:'a'.repeat(64),queryVersion:'1',configVersion:'20',anchor};
const observed={marketId,epoch:'3',maturityAt:week,source:'X_COUNTS',synthetic:false,
  collectionPath:'/state/tariff/collection.json',graduationSignature:'1'.repeat(88)};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'ante-weekly-keeper-'));
 const base=join(root,'initial');await mkdir(base);
 await writeFile(join(base,'keeper-scope.json'),JSON.stringify(scope));
 await writeFile(join(base,'observed-config.json'),JSON.stringify(observed));
 await writeFile(join(base,'settlements.json'),'{"settlements":{}}');
 return {root,base,market:{marketId,initialScopePath:join(base,'keeper-scope.json'),
  initialObservedConfigPath:join(base,'observed-config.json'),autoRoot:join(root,'auto')}};
}

test('weekly trigger waits for data cutoff and never repeats an opened LP window',()=>{
 assert.equal(inWeeklyServiceWindow(week+959),false);
 assert.equal(inWeeklyServiceWindow(week+960),true);
 assert.equal(inWeeklyServiceWindow(week+86_400+961),false);
 assert.equal(weeklyDue(finance(),week+959).due,false);
 assert.equal(weeklyDue(finance(),week+960).reason,'EMPTY_RECOVERY');
 assert.equal(weeklyDue(finance({openPositions:1}),week+960).reason,'OBSERVED_SETTLEMENT');
 assert.equal(weeklyDue(finance({openPositions:1}),week+86401).reason,'OBSERVED_SETTLEMENT');
 assert.equal(weeklyDue(finance({openPositions:1}),week+87300).reason,'OBSERVED_SETTLEMENT');
 assert.throws(()=>weeklyDue(finance({openPositions:1}),week+87361),/WEEKLY_OBSERVED_DEADLINE_EXCEEDED/);
 assert.equal(weeklyDue(finance({currentMaturity:0n}),week+960).due,true);
 assert.equal(weeklyDue(finance({currentMaturity:0n,lastLpMaturity:BigInt(week),
  lpWindowStart:BigInt(week+970),lpWindowEnd:BigInt(week+1870)}),week+1900).reason,'LP_ALREADY_OPENED');
});

test('validity recovery waits until two minutes after the five-minute publisher boundary',()=>{
 assert.equal(inValidityRecoveryTick(week+600),false);
 assert.equal(inValidityRecoveryTick(week+720),true);
 assert.equal(inValidityRecoveryTick(week+840),false);
 assert.equal(inValidityRecoveryTick(week+900),false);
});

test('market allowlist rejects duplicate and non-state paths',()=>{
 const entry={marketId,initialScopePath:'/state/a/scope.json',
  initialObservedConfigPath:'/state/a/source.json',autoRoot:'/state/a/auto'};
 assert.equal(validateWeeklyMarkets({cluster:'devnet',programId:program,completionPath:'/state/keeper/done.json',markets:[entry]}).length,1);
 assert.throws(()=>validateWeeklyMarkets({cluster:'devnet',programId:program,completionPath:'/state/keeper/done.json',markets:[entry,entry]}),/WEEKLY_CONFIG_INVALID/);
 assert.throws(()=>validateWeeklyMarkets({cluster:'devnet',programId:program,completionPath:'/state/keeper/done.json',
  markets:[{...entry,autoRoot:'/tmp/auto'}]}),/WEEKLY_CONFIG_INVALID/);
});

test('scope rotation persists a new cycle separately and refuses unexpected chain changes',async()=>{
 const f=await fixture();
 try{
  const next={...scope,epoch:'4',epochStartedAt:week+1000,maturityAt:week+604800};
  const run=async()=>({scope:next,cyclePositions:1});
  const active=await resolveWeeklyScope(f.market,finance({currentCycle:4n,
    currentMaturity:BigInt(next.maturityAt)}),{},run);
  assert.equal(active.scope.epoch,'4');
  assert.equal(JSON.parse(await readFile(active.configPath,'utf8')).maturityAt,next.maturityAt);
  assert.equal(JSON.parse(await readFile(f.market.initialScopePath,'utf8')).epoch,'3');
  const resumed=await resolveWeeklyScope(f.market,finance({currentCycle:4n,
    currentMaturity:BigInt(next.maturityAt)}),{},async()=>{throw Error('UNEXPECTED_DERIVATION');});
  assert.equal(resumed.scope.epoch,'4');
  await assert.rejects(resolveWeeklyScope(f.market,finance({currentCycle:6n,
    currentMaturity:BigInt(next.maturityAt+604800)}),{},run),/WEEKLY_SCOPE_ROTATION_MISMATCH/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('empty recovery signs only after an exact read-only plan; missing candidate blocks open positions',async()=>{
 const f=await fixture();
 try{
  const accounts={financeMarket:async()=>finance(),market:async()=>chainMarket};
  const calls=[];
  const run=async args=>{calls.push(args);
   return args.includes('--execute')?{marketId,epoch:'3',state:'submitted',action:'RECOVER_LP_WINDOW',signature:'sig'}:
    {marketId,epoch:'3',state:'ready',action:'RECOVER_LP_WINDOW'};};
  const result=await runWeeklyPass({now:week+960,markets:[f.market],accounts,env:{
   ANTE_UP_PUBLISHER_KEYPAIR_FILE:'/run/secrets/publisher.json',
   ANTE_UP_KEEPER_KEYPAIR_FILE:'/run/secrets/keeper.json'},execute:true,run});
  assert.equal(result[0].state,'submitted');assert.equal(calls.length,2);
  assert.ok(calls[1].includes('--execute'));
  const blocked=await runWeeklyPass({now:week+960,markets:[f.market],
   accounts:{financeMarket:async()=>finance({openPositions:1}),market:async()=>chainMarket},env:{},execute:true,
   run:async args=>{assert.equal(args[0],'scripts/prepare-observed-settlement.mjs');throw Error('OBSERVATION_INCOMPLETE');}});
  assert.equal(blocked[0].state,'blocked');assert.match(blocked[0].error,/OBSERVATION_INCOMPLETE/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('same-week validity reset reopens LP only with no maturity or open positions',async()=>{
 const now=week+3600,stale=finance({currentMaturity:0n,lastLpMaturity:BigInt(week),
   lpWindowStart:BigInt(week+960),lpWindowEnd:BigInt(week+1860)});
 const changed={validityGeneration:2n};
 assert.equal(validityRecoveryDue(stale,changed,now),true);
 assert.equal(weeklyDue(stale,now,changed).reason,'EMPTY_RECOVERY');
 assert.equal(validityRecoveryDue({...stale,currentMaturity:BigInt(week+604800)},changed,now),false);
 assert.equal(validityRecoveryDue({...stale,openPositions:1},changed,now),false);
 assert.equal(validityRecoveryDue(stale,changed,week+1000),false);
 assert.equal(validityRecoveryDue(stale,chainMarket,now),false);
 const f=await fixture();
 try{
  const calls=[];
  const run=async args=>{calls.push(args);return args.includes('--execute')?
   {marketId,epoch:'3',state:'submitted',action:'RECOVER_LP_WINDOW',signature:'sig'}:
   {marketId,epoch:'3',state:'ready',action:'RECOVER_LP_WINDOW'};};
  const accounts={financeMarket:async()=>stale,market:async()=>changed};
  const env={ANTE_UP_PUBLISHER_KEYPAIR_FILE:'/run/secrets/publisher.json',
    ANTE_UP_KEEPER_KEYPAIR_FILE:'/run/secrets/keeper.json'};
  assert.deepEqual((await runValidityRecoveryPass({now,markets:[f.market],accounts,env,run}))[0],
    {marketId,state:'ready',action:'RECOVER_LP_WINDOW'});
  assert.equal(calls.length,1);
  assert.deepEqual((await runValidityRecoveryPass({now,markets:[f.market],accounts,env,execute:true,run}))[0],
    {marketId,state:'submitted',action:'RECOVER_LP_WINDOW',signature:'sig'});
  assert.equal(calls.length,3);
  const quiet=await runValidityRecoveryPass({now,markets:[f.market],
    accounts:{financeMarket:async()=>stale,market:async()=>chainMarket},env,execute:true,run});
  assert.equal(quiet[0].reason,'NO_VALIDITY_RESET');
  assert.equal(calls.length,3);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
