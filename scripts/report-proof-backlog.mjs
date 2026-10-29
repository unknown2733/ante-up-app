// Read-only local journal and public API comparison. Pass record IDs, or omit
// them to inspect every recorded obligation. No private key or RPC file needed.
import {join} from 'node:path';
import {readJson} from '../services/evidence/worker-support.mjs';
const directory=process.env.ANTE_UP_LIVE_DIRECTORY;
if(!directory)throw Error('LIVE_DIRECTORY_REQUIRED');
const evidence=join(directory,'evidence');
const [jobs,intake,archivedLinks]=await Promise.all([readJson(join(evidence,'jobs.json'),{}),
 readJson(join(evidence,'intake.json'),{version:1,obligations:{}}),
 readJson(join(evidence,'jobs.json.archive-index.json'),{})]);
const ids=process.argv.slice(2).length?process.argv.slice(2):Object.keys(intake.obligations);
const origin=(process.env.ANTE_UP_PUBLIC_API_URL??'https://ante-up.fun/api').replace(/\/$/,'');
const read=async path=>{
 try{
  const response=await fetch(`${origin}/v1/${path}`,{signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}});
  if(!response.ok)return {error:`HTTP_${response.status}`};
  const result=await response.json();
  return result.mode==='devnet'?{data:result.data}:{error:'WRONG_MODE'};
 }catch{return {error:'PUBLIC_API_UNAVAILABLE'};}
};
for(const id of ids){
 if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id))throw Error('INVALID_RECORD_ID');
 const key=`proof:${id}:original`,job=jobs[key],archived=archivedLinks[key];
 const record=await read(`records/${encodeURIComponent(id)}`);
 const proofId=record.data?.proofId??null;
 const proof=proofId?await read(`proofs/${encodeURIComponent(proofId)}`):null;
 console.log(JSON.stringify({recordId:id,intake:intake.obligations[id]?.state??null,
  job:job?.state??archived?.state??null,jobConfirmations:job?.confirmations??archived?.confirmations??null,
  jobCompletion:job?.completion?.state??(archived?'FINALIZED':null),jobError:job?.error??archived?.error??null,
  publicRecord:record.error??record.data?.status??null,publicProofId:proofId,
  publicProof:proof?.error??proof?.data?.state??null}));
}
