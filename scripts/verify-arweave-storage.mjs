import {readFile,writeFile} from 'node:fs/promises';
import {createTurboStorageAdapter} from '../services/evidence/turbo.mjs';
import {createArweaveInclusionVerifier} from '../services/evidence/inclusion.mjs';
import {createReceiptVerifier} from '../services/evidence/receipt.mjs';
const file=process.env.ANTE_UP_EVIDENCE_JOBS_FILE;if(!file)throw Error('JOBS_FILE_REQUIRED');
const jobs=JSON.parse(await readFile(file,'utf8'));
const adapter=createTurboStorageAdapter({turbo:{upload:async()=>{throw Error('READ_ONLY');}},
 receiptVerifier:createReceiptVerifier({allowedAddresses:['JNC6vBhjHY1EPwV3pEeNmrsgFMxH5d38_LHsZ7jful8']}),inclusionVerifier:createArweaveInclusionVerifier()});
const results=[];
for(const job of Object.values(jobs)){
 for(const a of [...job.artifacts,{key:'manifest',ref:job.manifestRef,receipt:job.manifestReceipt}]){
  if(!a.ref)continue;
  const ref=a.ref.parentTransactionId?a.ref:await adapter.resolve(a.ref);
  if(!ref){results.push({key:a.key,state:'PARENT_PENDING'});continue;}
  const result=await adapter.verify(ref,a.receipt);
  results.push({key:a.key,ref,receiptValid:result.receiptValid,itemIncluded:result.itemIncluded,confirmations:result.confirmations,
    canonicalBytes:Buffer.byteLength(result.content)});
 }
}
console.log(JSON.stringify(results));
if(process.env.ANTE_UP_VERIFY_REPORT)await writeFile(process.env.ANTE_UP_VERIFY_REPORT,JSON.stringify(results,null,2));
