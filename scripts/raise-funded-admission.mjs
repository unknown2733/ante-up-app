// Operator-only Devnet admission change. Run under the evidence service lock.
// Dry run is the default; --execute signs once and journals before submission.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import * as chain from '../clients/chain/dist/index.js';
import {readJson} from '../services/evidence/worker-support.mjs';
import {fundedCapBudget} from '../services/evidence/intake.mjs';
import {createTurboClient} from '../services/evidence/turbo.mjs';

const require=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const kit=require('@solana/kit');
const required=name=>{const value=process.env[name];if(!value)throw Error(`MISSING_${name}`);return value;};
const encode=value=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():item);

async function main(){
 const raw=process.argv[2],execute=process.argv[3]==='--execute';
 assert.match(raw??'',/^(0|[1-9]\d*)$/,'CAP_REQUIRED');
 assert.ok(process.argv.length===3||process.argv.length===4&&execute,'INVALID_ARGUMENTS');
 const cap=Number(raw);
 assert.ok(Number.isSafeInteger(cap)&&cap>0,'INVALID_CAP');
 const directory=required('ANTE_UP_LIVE_DIRECTORY');
 const endpoint=(await readFile(required('ANTE_UP_RPC_URL_FILE'),'utf8')).trim();
 const rpc=kit.createSolanaRpc(endpoint),transport=chain.createKitChainTransport(endpoint);
 assert.equal(await rpc.getGenesisHash().send(),'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG','DEVNET_REQUIRED');
 const [gate,config,ledger]=await Promise.all([
  chain.readFinalizedAdmission(transport),chain.readFinalizedConfig(transport),
  readJson(join(directory,'evidence','budget.json'),{version:1,reservations:{}}),
 ]);
 const previousCap=Number(gate.data.fundedOpenCap),count=Number(gate.data.fundedOpenCount);
 assert.ok(Number.isSafeInteger(previousCap)&&Number.isSafeInteger(count)&&cap>previousCap&&cap>=count,'CAP_MUST_RISE');
 const turbo=await createTurboClient({privateKey:JSON.parse(await readFile(required('ANTE_UP_TURBO_KEY_FILE'),'utf8'))});
 const balance=await turbo.getBalance();
 const budget=fundedCapBudget({ledger,totalLimit:required('ANTE_UP_EVIDENCE_TOTAL_WINC'),
  dailyLimit:required('ANTE_UP_EVIDENCE_DAILY_WINC'),perRecordLimit:required('ANTE_UP_MAX_UPLOAD_WINC'),
  balanceWinc:balance.winc,outstanding:gate.data.outstanding,fundedOpenCount:count,cap});
 console.log(encode({mode:execute?'execute':'dry-run',previousCap,count,requestedCap:cap,
  gateOpen:gate.data.open,willReopenGate:!gate.data.open,
  outstanding:gate.data.outstanding,admit:budget.admit,reason:budget.reason,
  reservedFutureOpens:budget.reservedFutureOpens,totalReservedWinc:budget.totalReservedWinc,
  dailyReservedWinc:budget.dailyReservedWinc}));
 assert.ok(budget.admit,'INSUFFICIENT_PROOF_BUDGET');
 if(!execute)return;
 assert.equal(process.env.ANTE_UP_EVIDENCE_AUTO_DISCOVER,'yes','AUTO_PROOF_INTAKE_REQUIRED');
 const admin=await kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(
  await readFile(required('ANTE_UP_PAYER_KEYPAIR_FILE'),'utf8'))));
 assert.equal(admin.address,config.data.admin,'ADMISSION_ADMIN_MISMATCH');
 const journalPath=join(directory,'evidence',`funded-cap-${cap}.json`);
 await mkdir(join(directory,'evidence'),{recursive:true});
 const ix=await chain.getRaiseFundedOpenCapInstructionAsync({admin,cap:BigInt(cap)});
 const life=await transport.getLatestBlockhash();
 let message=kit.setTransactionMessageFeePayerSigner(admin,kit.createTransactionMessage({version:0}));
 message=kit.setTransactionMessageLifetimeUsingBlockhash({...life,blockhash:kit.blockhash(life.blockhash)},message);
 message=kit.appendTransactionMessageInstruction(ix,message);
 // A budget guard may have closed the old gate while the former cap was
 // exhausted. Reopen only as part of this freshly funded admin transaction.
 if(!gate.data.open){
  const reopen=await chain.getSetAdmissionGateInstructionAsync({admin,open:true});
  message=kit.appendTransactionMessageInstruction(reopen,message);
 }
 const tx=await kit.signTransactionMessageWithSigners(message);
 const signature=kit.getSignatureFromTransaction(tx);
 await writeFile(journalPath,encode({cap,signature,lastValidBlockHeight:String(life.lastValidBlockHeight),
  state:'SIGNED',at:new Date().toISOString()}),{flag:'wx',mode:0o600});
 await transport.sendTransaction(kit.getBase64Decoder().decode(kit.getTransactionEncoder().encode(tx)));
 for(let attempt=0;attempt<40;attempt++){
  const status=await transport.getSignatureStatus(signature);
  assert.ok(!status?.err,'FUNDED_CAP_TRANSACTION_FAILED');
  if(status?.confirmationStatus==='finalized'){
   const after=(await chain.readFinalizedAdmission(transport)).data;
   assert.equal(after.fundedOpenCap,BigInt(cap),'FUNDED_CAP_READBACK_MISMATCH');
   assert.equal(after.open,true,'FUNDED_GATE_READBACK_MISMATCH');
   await writeFile(journalPath,encode({cap,signature,state:'FINALIZED',at:new Date().toISOString()}),{mode:0o600});
   console.log(encode({state:'FINALIZED',cap,signature,count:String(after.fundedOpenCount)}));
   return;
  }
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 throw Error('FUNDED_CAP_TRANSACTION_UNKNOWN_RECONCILE_JOURNAL');
}
main().catch(error=>{
 const code=/^[A-Z][A-Z0-9_]+$/.test(error?.message??'')?error.message:'FUNDED_CAP_CHANGE_FAILED';
 console.error(code);process.exitCode=1;
});
