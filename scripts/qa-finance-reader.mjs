// Read-only production API financial reader against the isolated Devnet QA market.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import * as chain from '../clients/chain/dist/index.js';
import {KitFinalizedAccountReader} from '../services/indexer/src/repositories.ts';
import {FinalizedFinancialAccounts,FirstSliceFinancialReader} from '../services/api/src/financial-chain.ts';
import {SqliteFinancialRegistrationStore} from '../services/api/src/registration.ts';
import {validateFinancialIntent,validateFinancialQuote} from '../services/api/src/financial.ts';
import {safeError} from './qa-finance-devnet.mjs';
const kit=createRequire(new URL('../clients/chain/package.json',import.meta.url))('@solana/kit');
async function main(){
  const dir=process.env.ANTE_UP_QA_STATE_DIR;
  const endpoint=(await readFile(process.env.ANTE_UP_QA_RPC_FILE,'utf8')).trim();
  assert.equal(await kit.createSolanaRpc(endpoint).getGenesisHash().send(),'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  const journal=JSON.parse(await readFile(join(dir,'journal.json'),'utf8'));
  assert.equal(journal.synthetic,true);assert.equal(journal.label,'ante-up-synthetic-finance-qa-20261013-v1');
  const state=new FinalizedFinancialAccounts({cluster:'devnet',programId:chain.ANTE_UP_PROGRAM_ADDRESS,accounts:new KitFinalizedAccountReader(endpoint)});
  const registrations=new SqliteFinancialRegistrationStore(':memory:');
  try {
    const reader=new FirstSliceFinancialReader(state,registrations);
    const vault=await reader.vault(journal.market),portfolio=await reader.portfolio(journal.wallet);
    assert.equal(vault.finality,'finalized');assert.equal(portfolio.finality,'finalized');
    const m=await state.market(journal.market),fm=await state.financeMarket(journal.market);
    assert.equal(vault.value.proReserveAtoms,fm.proReserved.toString());assert.equal(vault.value.otherReserveAtoms,fm.otherReserved.toString());
    assert.equal(vault.value.lockedSharesAtoms,fm.lockedShares.toString());assert.ok(BigInt(vault.value.freeCapitalAtoms)>=0n);
    const latest=journal.observations.find(x=>x.candidate.sequence===m.latestSequence.toString());assert.ok(latest);
    const view={id:journal.market,keyword:'SYNTHETIC QA ONLY',aliases:[],phase:'INDEXED',dataStatus:'VALID',supported:true,
      epochPhase:vault.value.epochPhase,chain:{cluster:'devnet',programId:chain.ANTE_UP_PROGRAM_ADDRESS,address:journal.market},
      snapshot:{payload:latest.candidate,payloadHash:latest.candidateHash,finality:'finalized'},
      anchor:{graduationPriceAtoms:fm.anchorPg.toString(),graduationNowQ12:fm.anchorSg.toString(),graduation7dQ12:fm.anchorDg.toString(),maxPriceAtoms:fm.pmax.toString()},
      price:{kind:'indexed',executable:true},capabilities:{}};
    const quoted=[],actions=[['spotBuy',{quantityAtoms:'1000000'}],['spotSell',{quantityAtoms:'1000000'}]];
    if(['INITIAL_LP','LP_WINDOW'].includes(vault.value.epochPhase))actions.push(['depositLP',{quantityAtoms:'1000000'}]);
    if(vault.value.epochPhase==='PRO_OPEN')for(const direction of ['long','short'])actions.push(['openPro',{collateralAtoms:'10000000',leverageBps:'50000',direction}]);
    for(const [action,args]of actions){const now=Math.floor(Date.now()/1000);
      const intent=validateFinancialIntent({requestId:randomUUID(),wallet:journal.wallet,marketId:journal.market,action,...args});
      const quote=await reader.quote(intent,view,now);assert.ok(quote,`live ${action} quote`);
      validateFinancialQuote(quote,intent,view,{cluster:'devnet',programId:chain.ANTE_UP_PROGRAM_ADDRESS,now});
      quoted.push({action,direction:args.direction??null,priceAtoms:quote.priceAtoms,grossAtoms:quote.grossAtoms,tradeFeeAtoms:quote.tradeFeeAtoms,
        timePrepaidAtoms:quote.timePrepaidAtoms,maxPayoutAtoms:quote.maxPayoutAtoms});}
    const result={at:new Date().toISOString(),synthetic:true,market:journal.market,wallet:journal.wallet,readOnly:true,
      boundary:'production API reader/quote/validator with actual finalized Devnet accounts; no browser or HTTP mutation',vault,portfolio,quoted};
    const output=JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2);
    await writeFile(join(dir,`api-reader-${vault.value.epochPhase}.json`),output);console.log(output);
  }finally{registrations.close();}
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
