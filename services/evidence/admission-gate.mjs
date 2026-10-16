import {readJson,durableJson} from './worker-support.mjs';

const check=(ok,code)=>{if(!ok)throw Error(code);};

// Close only. Never reopen admission automatically. A signed gate transaction
// is journaled before transport and is never sent a second time on ambiguity.
export async function closeAdmissionOnce({path,readGate,signClose,send,getSignatureStatus}){
 const gate=await readGate();
 if(gate.open===false)return {state:'CLOSED'};
 check(gate.open===true,'ADMISSION_GATE_UNKNOWN');
 let journal=await readJson(path,null);
 if(!journal){
  const signed=await signClose();
  check(typeof signed?.wire==='string'&&typeof signed?.signature==='string','ADMISSION_SIGN_INVALID');
  journal={version:1,state:'SIGNED',wire:signed.wire,signature:signed.signature,createdAt:new Date().toISOString()};
  await durableJson(path,journal);
  try{await send(journal.wire);}catch{return {state:'UNKNOWN',signature:journal.signature};}
 }else{
  check(journal.version===1&&typeof journal.signature==='string'&&typeof journal.wire==='string','ADMISSION_JOURNAL_INVALID');
 }
 const status=await getSignatureStatus(journal.signature);
 if(status?.err)throw Error('ADMISSION_GATE_TRANSACTION_FAILED');
 if(status?.confirmationStatus!=='finalized')return {state:'UNKNOWN',signature:journal.signature};
 const final=await readGate();
 check(final.open===false,'ADMISSION_GATE_FINALITY_MISMATCH');
 await durableJson(path,{...journal,state:'FINALIZED'});
 return {state:'CLOSED',signature:journal.signature};
}
