import test from 'node:test';
import assert from 'node:assert/strict';
import * as sas from 'sas-lib';
import { createKitProofChain, createKitSasSender, createKitMarketVersionReader } from './kit.mjs';

test('Kit SAS sender and completeProof adapter use generated instruction and finalized record checks',async()=>{
  const address='1'.repeat(32),programId='2'.repeat(32),proofHash='a'.repeat(64);
  const instruction={programAddress:programId,data:Uint8Array.from([1,2,3])};
  const sdk={FreeState:{Open:0},decodeFreeRecord:()=>({data:{market:address,owner:address,id:9n}}),
    readFinalizedFreeRecord:async()=>({address,data:{market:address,owner:address,id:9n,
      state:1,proofComplete:false,proofHash:Uint8Array.from(Buffer.from(proofHash,'hex'))}}),
    createCompleteProofInstruction:async()=>({recordAddress:address,instruction}),
    prepareUnsignedTransaction:async()=>({unsignedTransaction:'wire'}),
    submitAndConfirmFinalized:async()=>({state:'FINALIZED',signature:'sig'})};
  const transport={getFinalizedAccount:async()=>({exists:true,address,programAddress:programId})};
  const proof=createKitProofChain({transport,programId,proofAuthority:{address},feePayer:address,
    sign:async()=>{},sdk});
  assert.deepEqual(await proof.readFinalizedProof(address),{proofComplete:false,proofHash});
  assert.deepEqual(await proof.sendCompleteInstruction({recordId:address,proofHash,instruction}),
    {signature:'sig',finalized:true});
  await assert.rejects(()=>proof.sendCompleteInstruction({recordId:address,proofHash,
    instruction:{...instruction,data:Uint8Array.from([9])}}),/COMPLETE_INSTRUCTION_MISMATCH/);
  const sasSender=createKitSasSender({transport,feePayer:address,sign:async()=>{},sdk});
  assert.deepEqual(await sasSender({instruction:{programAddress:sas.SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,data:new Uint8Array()}}),
    {signature:'sig',finalized:true});
});

test('Kit market version reader binds N/A evidence to finalized PDA/config accounts',async()=>{
  const address='1'.repeat(32),programId='2'.repeat(32),queryHash='a'.repeat(64);
  const transport={getFinalizedAccount:async()=>({exists:true,address,programAddress:programId})};
  const sdk={decodeMarket:()=>({data:{id:new Uint8Array(32).fill(1)}}),
    readFinalizedMarket:async()=>({address,data:{queryVersion:3n,queryHash:Uint8Array.from(Buffer.from(queryHash,'hex'))}}),
    readFinalizedConfig:async()=>({address:'3'.repeat(32),data:{configVersion:4n,
      formulaVersion:Uint8Array.from([...Buffer.from('h3-d7-q12-v1'),...new Uint8Array(4)])}})};
  const result=await createKitMarketVersionReader({transport,programId,sdk}).getFinalizedVersions(address);
  assert.equal(result.queryVersion,'3');assert.equal(result.configVersion,'4');
  assert.equal(result.queryHash,queryHash);assert.equal(result.source,'finalized-program-accounts');
});
