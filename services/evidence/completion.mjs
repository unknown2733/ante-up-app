import {FileJobRepository,payloadHash} from './index.mjs';

// The caller has independently validated finalized SAS claims and the program
// proof hash. This changes only the active journal, under the sole worker lock.
export async function reconcileCompletion(path,{recordId,proofHash,sasId}) {
 const repo=new FileJobRepository(path),jobs=await repo.read(),id=`proof:${recordId}:original`,job=jobs[id];
 if(!job||job.id!==id||job.recordId!==recordId||job.record?.id!==recordId||job.payload?.record?.id!==recordId||
   job.state!=='ISSUED'||job.sasId!==sasId||job.payloadHash!==proofHash||
   payloadHash(job.payload)!==proofHash)throw Error('COMPLETION_RECONCILE_CONFLICT');
 if(job.completion?.state==='FINALIZED')return job.completion;
 job.completion={state:'FINALIZED',signature:job.completion?.signature??null};
 await repo.write(jobs);return job.completion;
}
