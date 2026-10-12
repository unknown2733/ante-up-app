// Read-only per-transaction capital/fee audit. Output contains public chain data only.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import * as c from '../clients/chain/dist/index.js';
import {safeError} from './qa-finance-devnet.mjs';
const kit=createRequire(new URL('../clients/chain/package.json',import.meta.url))('@solana/kit');
async function main(){
 const dir=process.env.ANTE_UP_QA_STATE_DIR,endpoint=(await readFile(process.env.ANTE_UP_QA_RPC_FILE,'utf8')).trim();
 const rpc=kit.createSolanaRpc(endpoint),t=c.createKitChainTransport(endpoint),j=JSON.parse(await readFile(join(dir,'journal.json'),'utf8'));
 const core=(await c.readFinalizedConfig(t)).data,fc=(await c.readFinalizedFinanceConfig(t)).data,fm=(await c.readFinalizedFinanceMarket(t,j.market)).data;
 const transactions=[],totals={adminLamports:0n,publisherLamports:0n,qaLamports:0n,feesLamports:0n,treasuryAtoms:0n,graduationContributionAtoms:0n};
 for(const [step,record] of Object.entries(j.steps)){
  assert.equal(record.state,'FINALIZED');
  const tx=await rpc.getTransaction(record.signature,{commitment:'finalized',encoding:'json',maxSupportedTransactionVersion:0}).send();
  assert.ok(tx);assert.equal(tx.meta.err,null);
  const keys=tx.transaction.message.accountKeys;
  const lamports=address=>{const i=keys.indexOf(address);return i<0?0n:tx.meta.postBalances[i]-tx.meta.preBalances[i];};
  const treasuryIndex=keys.indexOf(fc.protocolTreasury);
  const tokenAmount=balances=>BigInt(balances.find(x=>Number(x.accountIndex)===treasuryIndex)?.uiTokenAmount.amount??'0');
  const row={step,signature:record.signature,slot:tx.slot,feeLamports:tx.meta.fee,
   adminLamports:lamports(core.admin),publisherLamports:lamports(core.publisher),qaLamports:lamports(j.wallet),
   treasuryAtoms:tokenAmount(tx.meta.postTokenBalances)-tokenAmount(tx.meta.preTokenBalances)};
  totals.adminLamports+=row.adminLamports;totals.publisherLamports+=row.publisherLamports;totals.qaLamports+=row.qaLamports;
  totals.feesLamports+=row.feeLamports;totals.treasuryAtoms+=row.treasuryAtoms;
  if(step==='graduate')totals.graduationContributionAtoms=-row.treasuryAtoms;
  transactions.push(row);
 }
 const result={at:new Date().toISOString(),cluster:'devnet',synthetic:true,market:j.market,wallet:j.wallet,
  finality:'finalized',transactions,totals,latestAdminLamports:(await rpc.getBalance(core.admin,{commitment:'finalized'}).send()).value,
  supportedMarkets:fc.supportedMarkets,externalQ:fm.externalQ,openPositions:fm.openPositions,proReserved:fm.proReserved,otherReserved:fm.otherReserved,
  shares:fm.totalShares,lockedShares:fm.lockedShares,heartbeat:'Stopped after finite QA; no scheduled process was created.',
  normalMaturity:'Not exercised live; local LiteSVM only.'};
 const output=JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2);
 await writeFile(join(dir,'monetary-audit.json'),output);console.log(output);
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
