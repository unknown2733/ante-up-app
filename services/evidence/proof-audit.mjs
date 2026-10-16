import {canonical,payloadHash,sha256} from './index.mjs';

const check=(ok,code)=>{if(!ok)throw Error(code);};

// Read-only audit of saved evidence. The storage adapter must independently
// verify receipt signatures, parent transactions, ANS-104 inclusion and bytes.
export async function verifyArchivedJob(job,storage){
 check(job?.id===`proof:${job.recordId}:original` && job.payload?.record?.id===job.recordId,'AUDIT_JOB_MISMATCH');
 check(job.payloadHash===payloadHash(job.payload),'AUDIT_PAYLOAD_HASH_MISMATCH');
 check(Array.isArray(job.artifacts)&&job.artifacts.length>0&&
  canonical(job.payload.evidence)===canonical(job.artifacts.map(a=>a.ref)),'AUDIT_EVIDENCE_MISMATCH');
 const items=[...job.artifacts.map(a=>({ref:a.ref,receipt:a.receipt,content:a.content})),
  {ref:job.manifestRef,receipt:job.manifestReceipt,content:canonical(job.payload)}];
 let minimum=Number.MAX_SAFE_INTEGER;
 for(const {ref,receipt,content} of items){
  check(ref?.contentHash===sha256(Buffer.from(content,'utf8'))&&receipt?.id===ref.arweaveItemId&&
   typeof ref.parentTransactionId==='string','AUDIT_ITEM_MISMATCH');
  const proof=await storage.verify(ref,receipt);
  check(proof?.receiptValid===true&&proof.itemId===ref.arweaveItemId&&
   proof.parentTransactionId===ref.parentTransactionId&&proof.itemIncluded===true&&
   sha256(Buffer.from(proof.content,'utf8'))===ref.contentHash&&
   Number.isSafeInteger(proof.confirmations)&&proof.confirmations>=20,'AUDIT_ITEM_NOT_FINAL');
  minimum=Math.min(minimum,proof.confirmations);
 }
 return {recordId:job.recordId,proofId:job.id,artifacts:job.artifacts.length,
  manifestItemId:job.manifestRef.arweaveItemId,minimumConfirmations:minimum,state:'ARCHIVE_VERIFIED'};
}
