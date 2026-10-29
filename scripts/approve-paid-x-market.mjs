import {randomUUID} from 'node:crypto';
import {open,readFile,rename,unlink} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {findMarketPda} from '../clients/chain/dist/index.js';
import {buildQuery} from '../services/data/index.mjs';
import {queryHashFor} from '../services/data/live.mjs';
import {assertPaidXApproved,validatePaidXRegistry} from './paid-x-approvals.mjs';

const [mode,registryPath,configPath]=process.argv.slice(2);
if(!['--plan','--apply'].includes(mode) || !registryPath || !configPath ||
    !isAbsolute(registryPath) || !isAbsolute(configPath))throw Error('APPROVAL_ARGS_INVALID');

async function candidate(){
  const config=JSON.parse(await readFile(configPath,'utf8'));
  const amount=name=>Number.isSafeInteger(config[name]) && config[name]>0 ? config[name] : 0;
  const estimate=amount('estimatedCostMicros'),initial=amount('initialEstimatedCostMicros');
  if(!estimate || initial<estimate || amount('initialLimitMicros')<initial ||
      amount('dailyLimitMicros')<estimate || amount('totalLimitMicros')<amount('initialLimitMicros'))
    throw Error('APPROVAL_BUDGET_INVALID');
  if(typeof config.seedHex!=='string' || !/^[a-f0-9]{64}$/.test(config.seedHex) ||
      config.queryVersion!=='1')throw Error('APPROVAL_CONFIG_INVALID');
  const [address]=await findMarketPda({marketId:Uint8Array.from(Buffer.from(config.seedHex,'hex'))});
  if(String(address)!==config.marketId)throw Error('APPROVAL_MARKET_PDA_MISMATCH');
  return {marketId:config.marketId,seedHex:config.seedHex,
    queryHash:queryHashFor(buildQuery(config.expressions)),queryVersion:config.queryVersion};
}

function nextRegistry(registry,entry){
  validatePaidXRegistry(registry);
  const old=registry.markets.find(item=>item.marketId===entry.marketId);
  if(old){
    assertPaidXApproved(registry,entry);
    return {registry,alreadyApproved:true};
  }
  if(registry.markets.length>=5)throw Error('PAID_X_APPROVAL_LIMIT');
  const next={...registry,markets:[...registry.markets,entry]};
  validatePaidXRegistry(next);
  return {registry:next,alreadyApproved:false};
}

let lock,temp;
try{
  const entry=await candidate();
  if(mode==='--apply')lock=await open(registryPath+'.lock','wx',0o600);
  const current=JSON.parse(await readFile(registryPath,'utf8'));
  const result=nextRegistry(current,entry);
  if(mode==='--apply' && !result.alreadyApproved){
    temp=registryPath+'.'+randomUUID()+'.tmp';
    const file=await open(temp,'wx',0o600);
    try{await file.writeFile(JSON.stringify(result.registry,null,2)+'\n');await file.sync();}
    finally{await file.close();}
    await rename(temp,registryPath);temp=null;
  }
  console.log(JSON.stringify({state:result.alreadyApproved?'ALREADY_APPROVED':mode==='--apply'?'APPROVED':'READY',
    marketId:entry.marketId,approvedCount:result.registry.markets.length,maxMarkets:5}));
}catch(error){
  console.error(/^[A-Z][A-Z0-9_]+$/.test(error?.message)?error.message:'PAID_X_APPROVAL_FAILED');
  process.exitCode=1;
}finally{
  if(temp)await unlink(temp).catch(()=>{});
  if(lock){await lock.close();await unlink(registryPath+'.lock').catch(()=>{});}
}
