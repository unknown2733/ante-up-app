import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import * as chain from '../clients/chain/dist/index.js';
import {FileJobRepository,canonical,payloadHash} from '../services/evidence/index.mjs';
import {createEvidenceRuntime,projectionReaders,createSemanticReaders,decodeAnteUpClaims} from '../services/evidence/runtime.mjs';
import {verifySemanticPacket} from '../services/evidence/semantic.mjs';
import {createKitSasSender,createKitProofChain,createKitMarketVersionReader,withKitSigners} from '../services/evidence/kit.mjs';
import {ReadOnlyProjection,durableJson,readJson,budgetedTransport,journalTransport} from '../services/evidence/worker-support.mjs';
import {checkStorage} from './runtime-status.mjs';
import {createReceiptVerifier} from '../services/evidence/receipt.mjs';
import {createArweaveInclusionVerifier} from '../services/evidence/inclusion.mjs';
import {createJournaledUpload,signedItemSize} from '../services/evidence/upload-journal.mjs';
import {createTurboClient,encodeStorageContent,storageTags,quoteUploadCosts} from '../services/evidence/turbo.mjs';
import {FileCandidateRepository} from '../services/data/publisher.mjs';
import {FileRawResponseRepository} from '../services/data/index.mjs';
import {SqliteProjectionStore} from '../services/indexer/src/sqlite.ts';
import {KitFinalizedAccountReader,SqliteEventRepositories} from '../services/indexer/src/repositories.ts';
import {FinalizedPoller} from '../services/indexer/src/poller.ts';
import {KitFinalizedRpc} from '../services/indexer/src/rpc.ts';
import {GeneratedProgramEventDecoder} from '../services/indexer/src/generated-decoder.ts';

const require=createRequire(new URL('../services/evidence/package.json',import.meta.url));
const kit=require('@solana/kit'),sas=require('sas-lib');
const required=name=>{if(!process.env[name])throw Error(`MISSING_${name}`);return process.env[name];};
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const preflightOnly=process.argv.includes('--preflight');
const save=async(path,value)=>{if(!preflightOnly)await durableJson(path,JSON.parse(JSON.stringify(value)));};
let projection,repositories;
try{
 const args=process.argv.slice(2);
 if(args.some(a=>!['--execute','--follow','--initialize-sas','--supervised','--preflight'].includes(a)))throw Error('INVALID_ARGUMENT');
 const supervised=args.includes('--supervised');
 if(preflightOnly&&(args.includes('--execute')||args.includes('--initialize-sas')||args.includes('--follow')))throw Error('INVALID_ARGUMENT');
 const execute=args.includes('--execute')||args.includes('--initialize-sas');
 if(execute&&process.env.ANTE_UP_ENABLE_EVIDENCE_LIVE!=='yes')throw Error('LIVE_EVIDENCE_DISABLED');
 const directory=required('ANTE_UP_LIVE_DIRECTORY'),out=join(directory,'evidence');if(!preflightOnly)await mkdir(out,{recursive:true});
 const reportOut=supervised?join(out,'reports',required('ANTE_UP_RECORD_ID')):out;
 if(!preflightOnly)await checkStorage(directory,{existingObligations:supervised&&process.env.ANTE_UP_EVIDENCE_AUTO_DISCOVER==='yes'});
 const endpoint=(await readFile(required('ANTE_UP_RPC_URL_FILE'),'utf8')).trim(),rpc=kit.createSolanaRpc(endpoint);
 if(await rpc.getGenesisHash().send()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw Error('DEVNET_REQUIRED');
 const payer=await kit.createKeyPairSignerFromBytes(Uint8Array.from(await json(required('ANTE_UP_PAYER_KEYPAIR_FILE'))));
 const authority=await kit.createKeyPairSignerFromBytes(Uint8Array.from(await json(required('ANTE_UP_ISSUER_KEYPAIR_FILE'))));
 const uploadKey=await json(required('ANTE_UP_TURBO_KEY_FILE'));
 const turbo=await createTurboClient({privateKey:uploadKey});
 const receiptDirectory=join(out,'receipts');if(!preflightOnly)await mkdir(receiptDirectory,{recursive:true});
 const {ArweaveSigner}=require('@dha-team/arbundles');
 let uploadTransport=turbo.uploadSignedDataItem.bind(turbo);
 if(supervised&&!preflightOnly)uploadTransport=budgetedTransport({path:join(out,'budget.json'),
  totalLimit:required('ANTE_UP_EVIDENCE_TOTAL_WINC'),dailyLimit:required('ANTE_UP_EVIDENCE_DAILY_WINC'),
  perRecordLimit:required('ANTE_UP_MAX_UPLOAD_WINC'),recordId:required('ANTE_UP_RECORD_ID'),
  quote:async bytes=>(await turbo.getUploadCosts({bytes:[bytes]}))[0].winc,
  balance:async()=>(await turbo.getBalance()).winc,send:uploadTransport});
 const uploadSigner=new ArweaveSigner(uploadKey);
 turbo.upload=createJournaledUpload({directory:receiptDirectory,signer:uploadSigner,uploadSignedDataItem:uploadTransport});
 const programId=chain.ANTE_UP_PROGRAM_ADDRESS,baseTransport=chain.createKitChainTransport(endpoint);
 const transport=supervised?journalTransport(baseTransport,join(out,'chain-submissions')):baseTransport;
 const marketVersionReader=createKitMarketVersionReader({transport,programId});
 const credentialName='Ante Up Devnet Evidence',schemaName='free-chip-result-v1';
 const [credential]=await sas.deriveCredentialPda({authority:authority.address,name:credentialName});
 const [schema]=await sas.deriveSchemaPda({credential,name:schemaName,version:1});
 const sign=withKitSigners([payer,authority]);
 const send=createKitSasSender({transport,feePayer:payer.address,sign,attempts:40,wait:()=>sleep(1500)});
 const proofChain=createKitProofChain({transport,programId,proofAuthority:authority,feePayer:payer.address,sign,attempts:40,wait:()=>sleep(1500)});
 projection=supervised||preflightOnly?new ReadOnlyProjection(join(directory,'index.sqlite')):new SqliteProjectionStore(join(directory,'index.sqlite'));
 const readers=projectionReaders(projection,{cluster:'devnet',programId});
 let repo=new FileJobRepository(join(out,'jobs.json'));
 if(preflightOnly){let state=await repo.read();repo={read:async()=>structuredClone(state),write:async value=>{state=structuredClone(value);}};}
 const metadataFile=join(out,'runtime.json');let metadata;
 try{metadata=await json(metadataFile);}catch(e){if(e.code!=='ENOENT')throw e;metadata={credential,schema,authority:authority.address,attestationExpiry:Math.floor(Date.now()/1000)+365*86400};await save(metadataFile,metadata);}
 if(metadata.credential!==credential||metadata.schema!==schema||metadata.authority!==authority.address)throw Error('ISSUER_CONFIG_MISMATCH');
 const sourceDirectories=[directory,...(process.env.ANTE_UP_EVIDENCE_EXTRA_SOURCE_DIRECTORIES??'').split(',').filter(Boolean)];
 const candidates=sourceDirectories.map(path=>new FileCandidateRepository(join(path,'candidates.json')));
 const rawSources=sourceDirectories.map(path=>new FileRawResponseRepository(join(path,'raw')));
 const candidateRepository={getPublished:async(marketId,sequence)=>{
  for(const source of candidates){const value=await source.getPublished(marketId,sequence);if(value)return value;}
  return null;
 }};
 const rawRepository={get:async hash=>{
  for(const source of rawSources){try{return await source.get(hash);}catch(error){if(error.code!=='ENOENT')throw error;}}
  throw Error('RAW_EVIDENCE_MISSING');
 }};
 const engine=await createEvidenceRuntime({jobRepository:repo,candidateRepository,
  rawRepository,recordReader:readers,snapshotReader:readers,marketVersionReader,
  turbo,storageOptions:{inclusionVerifier:createArweaveInclusionVerifier()},receiptVerifier:createReceiptVerifier({allowedAddresses:['JNC6vBhjHY1EPwV3pEeNmrsgFMxH5d38_LHsZ7jful8']}),
  rpc,credential,schema,payer,authority,sendSasInstruction:async request=>{const result=await send(request);await save(join(reportOut,'sas-submission.json'),{...request,instruction:undefined,...result});return result;},
  proofAuthority:authority,proofChain,programId,attestationExpiry:metadata.attestationExpiry,
  // Supervised uploads have a durable signed-item/receipt journal. A crash
  // between job checkpoints replays those same items without signing anew.
  uploadCheckpointEvery:supervised?8:1});
 const job=await engine.enqueueRecord(required('ANTE_UP_RECORD_ID'));
 // Replay the actual archived inputs BEFORE spending on permanent storage.
 const semantics=createSemanticReaders({recordReader:readers,snapshotReader:readers,candidateRepository,marketVersionReader});
 const payload={schemaVersion:'0.1',record:job.record,versions:job.versions,replacesProofId:null,
  evidence:job.artifacts.map(a=>({contentHash:a.contentHash,arweaveItemId:a.contentHash,parentTransactionId:'preflight-only'}))};
 await verifySemanticPacket(payload,await semantics.semanticPacketProvider(job.id,payload),semantics.chainVerifier,
  {fetch:async ref=>job.artifacts.find(a=>a.contentHash===ref.contentHash).content});
 console.log(JSON.stringify({state:'SOURCE_REPLAY_VERIFIED',recordId:job.recordId}));
 const stored=job.artifacts.map(a=>encodeStorageContent(a.content));
 const sizes=stored.map(s=>s.bytes.length);
 const signedSizes=await Promise.all(job.artifacts.map((a,i)=>signedItemSize({
  data:stored[i].bytes,tags:storageTags(stored[i],a.contentHash),signer:uploadSigner})));
 const [balance,free,costs]=await Promise.all([turbo.getBalance(),turbo.getFreeStatus(),quoteUploadCosts(turbo,[...signedSizes,16000])]);
 const cached=await Promise.all(job.artifacts.map(async a=>Boolean(a.ref||await readJson(join(receiptDirectory,`${a.contentHash}.json`),null))));
 const estimatedNewWinc=costs.reduce((sum,item,i)=>sum+((i<job.artifacts.length?cached[i]:job.manifestRef)?0n:BigInt(item.winc)),0n).toString();
 const preflight={recordId:job.recordId,jobId:job.id,credential,schema,authority:authority.address,estimatedNewWinc,
  artifacts:job.artifacts.map((a,i)=>({key:a.key,contentHash:a.contentHash,canonicalBytes:Buffer.byteLength(a.content),storedBytes:sizes[i],signedBytes:signedSizes[i],reused:cached[i]})),balance,free,costs,
  totalBytes:sizes.reduce((a,b)=>a+b,0),attestationExpiry:metadata.attestationExpiry};
 await save(join(reportOut,'preflight.json'),preflight);
 console.log(JSON.stringify({state:'PREFLIGHT',recordId:job.recordId,jobId:job.id,
  artifactCount:job.artifacts.length,totalBytes:preflight.totalBytes,estimatedNewWinc}));
 if(execute){
  // Maximum spend is an explicit native-unit cap, including the manifest.
  let account=await sas.fetchMaybeCredential(rpc,credential,{commitment:'finalized'});
  if(!account.exists&&supervised)throw Error('SAS_CONFIG_NOT_INITIALIZED');
  if(!account.exists){await send({instruction:sas.getCreateCredentialInstruction({payer,authority,credential,name:credentialName,signers:[authority.address]})});account=await sas.fetchMaybeCredential(rpc,credential,{commitment:'finalized'});}
  if(!account.exists||account.data.authority!==authority.address||!account.data.authorizedSigners?.includes(authority.address))throw Error('CREDENTIAL_MISMATCH');
  let schemaAccount=await sas.fetchMaybeSchema(rpc,schema,{commitment:'finalized'});
  if(!schemaAccount.exists&&supervised)throw Error('SAS_CONFIG_NOT_INITIALIZED');
  if(!schemaAccount.exists){await send({instruction:sas.getCreateSchemaInstruction({payer,authority,credential,schema,name:schemaName,
   description:'Ante Up finalized free-chip result. claims is canonical JSON linking the record and Arweave evidence. Operator attestation, Devnet only.',layout:Uint8Array.of(12),fieldNames:['claims']})});schemaAccount=await sas.fetchMaybeSchema(rpc,schema,{commitment:'finalized'});}
  if(!schemaAccount.exists||schemaAccount.data.credential!==credential||schemaAccount.data.isPaused||schemaAccount.data.layout.length!==1||schemaAccount.data.layout[0]!==12)throw Error('SCHEMA_MISMATCH');
  console.log(JSON.stringify({state:'SAS_CONFIG_FINALIZED',credential,schema}));
  if(args.includes('--initialize-sas')){projection.close();projection=null;process.exit(0);}
  const maxWinc=BigInt(required('ANTE_UP_MAX_UPLOAD_WINC'));
  const quoted=BigInt(estimatedNewWinc);
  if(quoted>maxWinc)throw Error('UPLOAD_BUDGET_EXCEEDED');
  if(BigInt(balance.winc??'0')<quoted)throw Error('TURBO_BALANCE_REQUIRED');
  do{
   const result=await engine.run(job.id);await save(join(reportOut,'result.json'),result);console.log(JSON.stringify(result));
   if(result.completion?.state==='FINALIZED'){
    const scope={cluster:'devnet',programId,address:programId};
    if(!supervised){
     repositories=new SqliteEventRepositories(join(directory,'index.sqlite'),new KitFinalizedAccountReader(endpoint));
     await repositories.importProofFile(repo.path,scope);
     const poller=new FinalizedPoller(projection,new KitFinalizedRpc(endpoint),new GeneratedProgramEventDecoder({snapshots:repositories,proofs:repositories}),100);
     await poller.pollOnce(scope);
    }
    const record=await readers.getFinalizedRecord(job.recordId);
    if(record?.proofId!==job.id&&supervised){console.log(JSON.stringify({state:'AWAITING_INDEXER',recordId:job.recordId}));break;}
    if(record?.proofId!==job.id)throw Error('INDEXED_PROOF_MISMATCH');
    const account=await sas.fetchAttestation(rpc,result.proof.sasId,{commitment:'finalized'});
    const claims=decodeAnteUpClaims(account.data.data);
    const proof=await proofChain.readFinalizedProof(job.recordId);
    if(claims.payloadHash!==result.proof.payloadHash||!proof.proofComplete||proof.proofHash!==claims.payloadHash)throw Error('FINAL_PROOF_MISMATCH');
    const report={state:'VERIFIED_FINALIZED',record,proof:result.proof,completion:result.completion,sas:{address:account.address,
     programAddress:account.programAddress,credential:account.data.credential,schema:account.data.schema,signer:account.data.signer,
     expiry:account.data.expiry.toString(),claims},protocolProof:proof};
    await save(join(reportOut,'final-readback.json'),report);console.log(JSON.stringify(report));break;
   }
   if(result.proof.error)throw Error(result.proof.error);
   if(!args.includes('--follow'))break;
   const delay=Math.max(5,(result.proof.retryAt??Math.floor(Date.now()/1000)+5)-Math.floor(Date.now()/1000));
   await sleep(Math.min(delay,300)*1000);
  }while(true);
 }
}catch(error){console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'LIVE_EVIDENCE_FAILED');
 // Report only the error class, standard code and source location. Provider
 // messages can contain endpoint URLs or credentials, so never print them.
 const location=(error.stack??'').match(/(?:\/app|\/work)\/[A-Za-z0-9_./-]+:\d+:\d+/)?.[0]??null;
 const code=typeof error.code==='string'&&/^[A-Z][A-Z0-9_]+$/.test(error.code)?error.code:null;
 console.error(JSON.stringify({errorClass:error.name??'Error',code,location}));process.exitCode=1;}
finally{repositories?.close();projection?.close();}
