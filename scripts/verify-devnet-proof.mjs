// Read-only verification: RPC URL file, durable proof job and index DB only.
// No payer, issuer or upload private key is accepted by this command.
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import * as chain from '../clients/chain/dist/index.js';
import {canonical,payloadHash} from '../services/evidence/index.mjs';
import {decodeAnteUpClaims,nonceForProofJob,projectionReaders} from '../services/evidence/runtime.mjs';
import {ReadOnlyProjection} from '../services/evidence/worker-support.mjs';
const require=createRequire(new URL('../services/evidence/package.json',import.meta.url));
const kit=require('@solana/kit'),sas=require('sas-lib');
const check=(ok,code)=>{if(!ok)throw Error(code);};
const required=name=>{check(process.env[name],`MISSING_${name}`);return process.env[name];};
const json=async path=>JSON.parse(await readFile(path,'utf8'));
let projection;
try{
 const directory=required('ANTE_UP_LIVE_DIRECTORY'),recordId=required('ANTE_UP_RECORD_ID');
 const endpoint=(await readFile(required('ANTE_UP_RPC_URL_FILE'),'utf8')).trim();
 const rpc=kit.createSolanaRpc(endpoint);
 check(await rpc.getGenesisHash().send()==='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG','DEVNET_REQUIRED');
 const jobs=await json(join(directory,'evidence/jobs.json'));
 const job=jobs[`proof:${recordId}:original`];check(job?.recordId===recordId,'JOB_REQUIRED');
 check(job.payloadHash===payloadHash(job.payload),'PAYLOAD_HASH_MISMATCH');
 const metadata=await json(join(directory,'evidence/runtime.json'));
 const transport=chain.createKitChainTransport(endpoint);
 const encoded=await transport.getFinalizedAccount(recordId);
 check(encoded?.exists&&encoded.programAddress===chain.ANTE_UP_PROGRAM_ADDRESS,'RECORD_OWNER_MISMATCH');
 const decoded=chain.decodeFreeRecord(encoded);
 const record=await chain.readFinalizedFreeRecord(transport,decoded.data.market,decoded.data.owner,decoded.data.id);
 check(record.address===recordId&&record.data.state!==chain.FreeState.Open,'RECORD_STATE_MISMATCH');
 const [address]=await sas.deriveAttestationPda({credential:metadata.credential,schema:metadata.schema,nonce:nonceForProofJob(job.id)});
 const account=await sas.fetchMaybeAttestation(rpc,address,{commitment:'finalized'});
 const hash=Buffer.from(record.data.proofHash).toString('hex');
 let report={checkedAt:new Date().toISOString(),recordId,state:'PENDING',workerState:job.state,
  confirmations:job.confirmations??null,sasAddress:address,sasExists:account.exists,
  protocolProofComplete:record.data.proofComplete,protocolProofHash:hash};
 if(account.exists){
  check(account.programAddress===sas.SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,'SAS_OWNER_MISMATCH');
  check(account.data.credential===metadata.credential&&account.data.schema===metadata.schema&&
   account.data.signer===metadata.authority,'SAS_AUTHORITY_MISMATCH');
  check(account.data.expiry===BigInt(metadata.attestationExpiry)&&account.data.expiry>BigInt(Math.floor(Date.now()/1000)),'SAS_EXPIRY_MISMATCH');
  const claims=decodeAnteUpClaims(account.data.data);
  const expected={jobId:job.id,payloadHash:job.payloadHash,manifestItemId:job.manifestRef.arweaveItemId,
   manifestParentId:job.manifestRef.parentTransactionId,recordId};
  check(canonical(claims)===canonical(expected),'SAS_CLAIM_MISMATCH');
  const [credential,schema]=await Promise.all([
   sas.fetchCredential(rpc,metadata.credential,{commitment:'finalized'}),
   sas.fetchSchema(rpc,metadata.schema,{commitment:'finalized'})]);
  check(credential.data.authority===metadata.authority&&credential.data.authorizedSigners.includes(metadata.authority),'CREDENTIAL_MISMATCH');
  check(schema.data.credential===metadata.credential&&!schema.data.isPaused&&
   schema.data.layout.length===1&&schema.data.layout[0]===12,'SCHEMA_MISMATCH');
  report={...report,state:'SAS_FINALIZED',claims,issuer:account.data.signer,expiry:account.data.expiry.toString()};
  if(record.data.proofComplete){
   check(hash===job.payloadHash,'PROTOCOL_HASH_MISMATCH');
   projection=new ReadOnlyProjection(join(directory,'index.sqlite'));
   const indexed=await projectionReaders(projection,{cluster:'devnet',programId:chain.ANTE_UP_PROGRAM_ADDRESS}).getFinalizedRecord(recordId);
   check(indexed?.proofId===job.id,'INDEXED_PROOF_MISMATCH');
   check(job.state==='ISSUED'&&job.completion?.state==='FINALIZED','JOURNAL_COMPLETION_MISMATCH');
   report={...report,state:'VERIFIED_FINALIZED',indexedProofId:indexed.proofId,completionSignature:job.completion.signature};
   // Query the already running public API from this read-only process. Creating
   // a local live app would open the SQLite projection in write mode.
   const {createHttpApi}=await import('../apps/web/src/http.ts');
   const api=createHttpApi(process.env.ANTE_UP_PUBLIC_API_URL??'https://ante-up.fun/api',{allowFixture:false});
   const [recordPage,proofPage]=await Promise.all([api.getRecord(recordId),api.getProof(job.id)]);
   check(recordPage.mode==='devnet'&&recordPage.data?.proofId===job.id,'HTTP_RECORD_MISMATCH');
   check(proofPage.mode==='devnet'&&proofPage.data?.state==='ISSUED'&&proofPage.data.sasId===address&&
    proofPage.data.payloadHash===hash&&proofPage.data.manifestRef?.arweaveItemId===claims.manifestItemId,'HTTP_PROOF_MISMATCH');
   report.http={mode:proofPage.mode,recordLinked:true,state:proofPage.data.state,sasId:proofPage.data.sasId,
    payloadHash:proofPage.data.payloadHash,confirmations:proofPage.data.confirmations};
  }
 }else check(!record.data.proofComplete,'SAS_MISSING_FOR_COMPLETE_RECORD');
 console.log(JSON.stringify(report));
 if(process.env.ANTE_UP_VERIFY_REPORT)await writeFile(process.env.ANTE_UP_VERIFY_REPORT,JSON.stringify(report,null,2));
}catch(error){
 console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'PROOF_VERIFICATION_FAILED');process.exitCode=1;
}finally{projection?.close();}
