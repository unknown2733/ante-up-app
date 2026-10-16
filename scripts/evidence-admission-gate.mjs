// Close-only admission guard. One invocation per worker pass, behind the same
// flock. It never changes proof jobs or opens a previously closed gate.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import * as chain from '../clients/chain/dist/index.js';
import {readJson} from '../services/evidence/worker-support.mjs';
import {admissionBudget} from '../services/evidence/intake.mjs';
import {closeAdmissionOnce} from '../services/evidence/admission-gate.mjs';
import {storagePressure} from './runtime-status.mjs';
import {createTurboClient} from '../services/evidence/turbo.mjs';

const require=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const kit=require('@solana/kit');
const required=name=>{if(!process.env[name])throw Error(`MISSING_${name}`);return process.env[name];};
try{
 const directory=required('ANTE_UP_LIVE_DIRECTORY'),evidence=join(directory,'evidence');
 const endpoint=(await readFile(required('ANTE_UP_RPC_URL_FILE'),'utf8')).trim();
 const rpc=kit.createSolanaRpc(endpoint),transport=chain.createKitChainTransport(endpoint);
 if(await rpc.getGenesisHash().send()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw Error('DEVNET_REQUIRED');
 const [gate,config,ledger]=await Promise.all([chain.readFinalizedAdmission(transport),
  chain.readFinalizedConfig(transport),readJson(join(evidence,'budget.json'),{version:1,reservations:{}})]);
 const turbo=await createTurboClient({privateKey:JSON.parse(await readFile(required('ANTE_UP_TURBO_KEY_FILE'),'utf8'))});
 const balance=await turbo.getBalance();
 const budget=admissionBudget({ledger,totalLimit:required('ANTE_UP_EVIDENCE_TOTAL_WINC'),
  dailyLimit:required('ANTE_UP_EVIDENCE_DAILY_WINC'),perRecordLimit:required('ANTE_UP_MAX_UPLOAD_WINC'),
  balanceWinc:balance.winc,outstanding:gate.data.outstanding});
 const pressure=await storagePressure(directory);
 if(pressure?.admissionBlocked){budget.admit=false;budget.reason='STORAGE_PRESSURE';}
 if(budget.admit||gate.data.open===false){
  console.log(JSON.stringify({state:gate.data.open?'ADMISSION_WITHIN_BUDGET':'ADMISSION_ALREADY_CLOSED',...budget}));
 }else{
  const signer=await kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(
   await readFile(required('ANTE_UP_PAYER_KEYPAIR_FILE'),'utf8'))));
  if(signer.address!==config.data.admin)throw Error('ADMISSION_ADMIN_MISMATCH');
  const result=await closeAdmissionOnce({path:join(evidence,'admission-close.json'),
   readGate:async()=>({open:(await chain.readFinalizedAdmission(transport)).data.open}),
   signClose:async()=>{
    const instruction=await chain.getSetAdmissionGateInstructionAsync({admin:signer,open:false});
    const life=await transport.getLatestBlockhash();
    let message=kit.setTransactionMessageFeePayerSigner(signer,kit.createTransactionMessage({version:0}));
    message=kit.setTransactionMessageLifetimeUsingBlockhash({...life,blockhash:kit.blockhash(life.blockhash)},message);
    message=kit.appendTransactionMessageInstruction(instruction,message);
    const tx=await kit.signTransactionMessageWithSigners(message);
    return {wire:kit.getBase64Decoder().decode(kit.getTransactionEncoder().encode(tx)),
     signature:kit.getSignatureFromTransaction(tx)};
   },send:wire=>transport.sendTransaction(wire),
   getSignatureStatus:signature=>transport.getSignatureStatus(signature)});
  console.log(JSON.stringify({state:`ADMISSION_${result.state}`,reason:budget.reason,
   totalReservedWinc:budget.totalReservedWinc,dailyReservedWinc:budget.dailyReservedWinc,
   acceptedObligationReserveWinc:budget.acceptedObligationReserveWinc}));
  if(result.state!=='CLOSED')process.exitCode=2;
 }
}catch(error){console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'ADMISSION_GUARD_FAILED');process.exitCode=1;}
