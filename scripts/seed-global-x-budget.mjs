import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,rmSync} from 'node:fs';
import {isAbsolute,dirname} from 'node:path';
import {GlobalXBudget} from '../services/data/global-budget.mjs';

const [mode,dbPath,...statePaths]=process.argv.slice(2);
if(!['--plan','--apply'].includes(mode)||!isAbsolute(dbPath)||statePaths.length<1||
    statePaths.length>5||statePaths.some(path=>!isAbsolute(path)))
  throw Error('GLOBAL_X_SEED_ARGS_INVALID');

let temp=null;
try{
  if(mode==='--apply'&&existsSync(dbPath))throw Error('GLOBAL_X_BUDGET_ALREADY_INITIALIZED');
  const rows=[],markets=new Set();
  for(const path of statePaths){
    const state=JSON.parse(readFileSync(path,'utf8'));
    const ids=Object.keys(state.markets??{});
    if(ids.length!==1||markets.has(ids[0])||!Number.isSafeInteger(state.totalSpentMicros)||
        state.totalSpentMicros<0)throw Error('GLOBAL_X_SEED_STATE_INVALID');
    const marketId=ids[0];markets.add(marketId);
    let regular=0;
    for(const [day,costMicros] of Object.entries(state.spentByDay??{})){
      if(!Number.isSafeInteger(costMicros)||costMicros<0)throw Error('GLOBAL_X_SEED_STATE_INVALID');
      regular+=costMicros;
      if(costMicros)rows.push({id:`baseline:${marketId}:${day}`,marketId,day,kind:'regular',costMicros,at:0});
    }
    const initial=state.totalSpentMicros-regular;
    if(initial<0)throw Error('GLOBAL_X_SEED_STATE_INVALID');
    if(initial)rows.push({id:`baseline-initial:${marketId}`,marketId,
      day:'1970-01-01',kind:'initial',costMicros:initial,at:0});
  }
  if(mode==='--apply')mkdirSync(dirname(dbPath),{recursive:true});
  temp=mode==='--plan'?':memory:':dbPath+'.'+randomUUID()+'.tmp';
  const budget=new GlobalXBudget(temp);
  let totals;
  try{
    for(const row of rows)budget.reserve(row);
    totals=budget.totals(new Date().toISOString().slice(0,10));
  }finally{budget.close();}
  if(mode==='--apply'){renameSync(temp,dbPath);temp=null;}
  console.log(JSON.stringify({state:mode==='--apply'?'INITIALIZED':'READY',
    marketCount:markets.size,reservationCount:rows.length,...totals}));
}catch(error){
  console.error(/^[A-Z][A-Z0-9_]+$/.test(error?.message)?error.message:'GLOBAL_X_SEED_FAILED');
  process.exitCode=1;
}finally{if(temp&&temp!==':memory:')rmSync(temp,{force:true});}
