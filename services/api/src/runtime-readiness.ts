import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MarketView } from '../../../contracts/types.ts';

const reasons = {
  STATE_STORAGE_LIMIT: 'STORAGE_PRESSURE', HOST_STORAGE_LOW: 'STORAGE_PRESSURE',
  PUBLICATION_PENDING: 'PUBLICATION_PENDING', RPC_RATE_LIMITED: 'RPC_RATE_LIMITED',
} as const;
/** Diagnostics only. Missing, old, foreign or malformed reports never override chain gates. */
export async function readRuntimeReadiness(directory:string,marketId:string,now:number):Promise<MarketView['runtimeStatus']> {
  if(!Number.isSafeInteger(now)||now<0)return undefined;
  const reports=await Promise.all(['collector','collector-tariff'].map(async role=>{
    try {
      const raw=await readFile(join(directory,`${role}.json`),'utf8');
      if(raw.length>16_384)return undefined;
      const value=JSON.parse(raw);
      if(value.role!==role||value.marketId!==marketId||!Number.isSafeInteger(value.at)||value.at<0||
        value.at>now*1000+999||now*1000-value.at>180_000||value.state!=='WAITING'||
        !Object.hasOwn(reasons,value.reason))return undefined;
      return {reason:reasons[value.reason as keyof typeof reasons],checkedAt:Math.floor(value.at/1000)};
    }catch{return undefined;}
  }));
  return reports.filter((value):value is NonNullable<typeof value>=>!!value)
    .sort((a,b)=>b.checkedAt-a.checkedAt)[0];
}
