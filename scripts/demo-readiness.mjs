// Devnet read-only diagnostic; never opens signers or submits transactions.
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import * as chain from '../clients/chain/dist/index.js';
const req=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const kit=req('@solana/kit');
const safe=e=>String(e?.message??'READINESS_FAILED').replace(/https?:\/\/[^\s"'<>]+/g,'[RPC_URL_REDACTED]').slice(0,300);
async function main(){
 const endpoint=(await readFile(process.env.ANTE_UP_RPC_URL_FILE,'utf8')).trim();
 const rpc=kit.createSolanaRpc(endpoint),t=chain.createKitChainTransport(endpoint);
 if(await rpc.getGenesisHash().send()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw new Error('DEVNET_REQUIRED');
 const [pda]=await chain.findAdmissionPda(),a=chain.getAdmissionDecoder().decode((await t.getFinalizedAccount(pda)).data);
 const clock=await t.getFinalizedAccount(kit.address('SysvarC1ock11111111111111111111111111111111'));
 const chainNow=Buffer.from(clock.data).readBigInt64LE(32),recent=a.recent.filter(at=>at>0n&&chainNow-at<86400n).length;
 const blockers=[];if(!a.open)blockers.push('OPERATOR_PAUSED');if(a.fundedOpenCount>=a.fundedOpenCap)blockers.push('FUNDED_PROOF_CAP');if(a.outstanding>=200)blockers.push('GLOBAL_OUTSTANDING_LIMIT');if(recent>=100)blockers.push('GLOBAL_DAILY_LIMIT');
 const finance=(await chain.readFinalizedFinanceConfig(t)).data;
 const report={readOnly:true,cluster:'devnet',chainNow,admission:{address:pda,open:a.open,outstanding:a.outstanding,recent24h:recent,
  fundedOpenCap:a.fundedOpenCap,fundedOpenCount:a.fundedOpenCount,fundedOpensRemaining:a.fundedOpenCap-a.fundedOpenCount,blockers},financeConfig:finance,markets:[]};
 for(const market of process.argv.slice(2)){
  const fm=(await chain.readFinalizedFinanceMarket(t,kit.address(market))).data;
  const raw=await t.getFinalizedAccount(kit.address(market));const m=chain.getMarketDecoder().decode(raw.data);
  report.markets.push({address:market,phase:m.phase,dataStatus:m.dataStatus,admission:m.admission,
   dataThrough:m.latestDataThrough,ageSeconds:chainNow-m.latestDataThrough,validityGeneration:m.validityGeneration,finance:fm});
 }
 console.log(JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2));
}
main().catch(e=>{console.error(safe(e));process.exitCode=1;});
