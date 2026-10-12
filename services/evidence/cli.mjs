import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileJobRepository } from './index.mjs';
import { FileRawResponseRepository } from '../data/index.mjs';
import { FileCandidateRepository } from '../data/publisher.mjs';
import { createEvidenceRuntime, projectionReaders } from './runtime.mjs';
import { createKitProofChain, createKitSasSender, createKitMarketVersionReader, withKitSigners } from './kit.mjs';
import { createSolanaRpc } from '@solana/kit';

export function requiredLiveConfig(env,argv) {
  if (!argv.includes('--execute') || env.ANTE_UP_ENABLE_EVIDENCE_LIVE !== 'yes') throw new Error('LIVE_EVIDENCE_DISABLED');
  for (const name of ['ANTE_UP_EVIDENCE_JOBS_FILE','ANTE_UP_CANDIDATE_FILE','ANTE_UP_RAW_DIRECTORY','ANTE_UP_EVIDENCE_RUNTIME_MODULE']) {
    if (!env[name]) throw new Error(`MISSING_${name}`);
  }
  if (!env.ANTE_UP_PROOF_ID && !env.ANTE_UP_RECORD_ID) throw new Error('MISSING_PROOF_OR_RECORD_ID');
  return {jobsFile:env.ANTE_UP_EVIDENCE_JOBS_FILE,proofId:env.ANTE_UP_PROOF_ID,
    recordId:env.ANTE_UP_RECORD_ID,candidateFile:env.ANTE_UP_CANDIDATE_FILE,
    rawDirectory:env.ANTE_UP_RAW_DIRECTORY,runtimeModule:env.ANTE_UP_EVIDENCE_RUNTIME_MODULE};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {
    const config=requiredLiveConfig(process.env,process.argv.slice(2));
    const runtime=await import(pathToFileURL(resolve(config.runtimeModule)).href);
    const chainSdk=await import('../../clients/chain/dist/index.js');
    const transport=runtime.transport??chainSdk.createKitChainTransport(runtime.endpoint);
    const feePayer=runtime.feePayer??runtime.payer;
    const proofChain=createKitProofChain({transport,programId:runtime.programId,
      proofAuthority:runtime.proofAuthority,feePayer:feePayer?.address,
      sign:runtime.signProof??withKitSigners([feePayer,runtime.proofAuthority])});
    const sendSasInstruction=createKitSasSender({transport,feePayer:feePayer?.address,
      sign:runtime.signSas??withKitSigners([feePayer,runtime.authority])});
    const readers=runtime.projection ? projectionReaders(runtime.projection,runtime.scope) :
      {recordReader:runtime.recordReader,snapshotReader:runtime.snapshotReader};
    const engine=await createEvidenceRuntime({...runtime,proofChain,sendSasInstruction,
      marketVersionReader:createKitMarketVersionReader({transport,programId:runtime.programId}),
      rpc:runtime.rpc??createSolanaRpc(runtime.endpoint),
      privateKey:runtime.turboPrivateKey,receiptVerifier:runtime.verifyTurboReceipt,
      jobRepository:new FileJobRepository(config.jobsFile),
      candidateRepository:new FileCandidateRepository(config.candidateFile),
      rawRepository:new FileRawResponseRepository(config.rawDirectory),
      recordReader:readers.recordReader??readers,snapshotReader:readers.snapshotReader??readers});
    const jobId=config.recordId ? (await engine.enqueueRecord(config.recordId)).id : config.proofId;
    process.stdout.write(JSON.stringify(await engine.run(jobId))+'\n');
  } catch(e) { process.stderr.write(String(e.message??e)+'\n'); process.exitCode=1; }
}
