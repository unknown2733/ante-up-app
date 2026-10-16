import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,payloadHash,sha256} from './index.mjs';
import {verifyArchivedJob} from './proof-audit.mjs';

test('archive audit checks every artifact and manifest with 20 confirmations',async()=>{
 const content='{"a":1}',hash=sha256(Buffer.from(content));
 const ref={contentHash:hash,arweaveItemId:'item',parentTransactionId:'parent'};
 const payload={record:{id:'record'},evidence:[ref]};
 const manifest=canonical(payload),manifestHash=payloadHash(payload);
 const job={id:'proof:record:original',recordId:'record',payload,payloadHash:manifestHash,
  artifacts:[{content,ref,receipt:{id:'item'}}],
  manifestRef:{contentHash:manifestHash,arweaveItemId:'manifest',parentTransactionId:'parent'},
  manifestReceipt:{id:'manifest'}};
 let confirmations=19,calls=0;
 const storage={async verify(item){calls++;return {receiptValid:true,itemId:item.arweaveItemId,
  parentTransactionId:item.parentTransactionId,itemIncluded:true,
  content:item.arweaveItemId==='manifest'?manifest:content,confirmations};}};
 await assert.rejects(()=>verifyArchivedJob(job,storage),/AUDIT_ITEM_NOT_FINAL/);
 assert.equal(calls,1);
 confirmations=20;
 assert.deepEqual(await verifyArchivedJob(job,storage),{recordId:'record',proofId:job.id,
  artifacts:1,manifestItemId:'manifest',minimumConfirmations:20,state:'ARCHIVE_VERIFIED'});
 assert.equal(calls,3);
 await assert.rejects(()=>verifyArchivedJob({...job,manifestReceipt:{id:'wrong'}},storage),/AUDIT_ITEM_MISMATCH/);
});
