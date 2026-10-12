import * as chainSdk from '../../clients/chain/dist/index.js';
import * as sas from 'sas-lib';
import { signTransactionWithSigners } from '@solana/kit';

const check=(ok,code='KIT_RUNTIME_CONFIG')=>{if(!ok)throw new Error(code);};
const hex=bytes=>Buffer.from(bytes).toString('hex');

export const withKitSigners=signers=>{
  check(Array.isArray(signers) && signers.every(s=>s?.address),'KIT_SIGNERS_REQUIRED');
  const unique=[...new Map(signers.map(s=>[s.address,s])).values()];
  return transaction=>signTransactionWithSigners(unique,transaction);
};

export function createKitSasSender({transport,feePayer,sign,wait,attempts,sdk=chainSdk}) {
  check(transport && feePayer && typeof sign==='function');
  return async ({instruction})=>{
    check(instruction?.programAddress===sas.SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,'SAS_PROGRAM_MISMATCH');
    const prepared=await sdk.prepareUnsignedTransaction({transport,instruction,feePayer,
      programAddress:sas.SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS});
    const result=await sdk.submitAndConfirmFinalized({transport,prepared,expectedInstruction:instruction,sign,wait,attempts});
    if (result.state==='FAILED') throw new Error(result.reason);
    return {signature:result.signature,finalized:result.state==='FINALIZED'};
  };
}

export function createKitProofChain({transport,programId,proofAuthority,feePayer,sign,wait,attempts,sdk=chainSdk}) {
  check(transport && programId && proofAuthority?.address && feePayer && typeof sign==='function');
  async function recordAccount(recordAddress){
    const encoded=await transport.getFinalizedAccount(recordAddress);
    check(encoded?.exists===true && encoded.address===recordAddress && encoded.programAddress===programId,
      'RECORD_ACCOUNT_MISMATCH');
    const decoded=sdk.decodeFreeRecord(encoded);
    const verified=await sdk.readFinalizedFreeRecord(transport,decoded.data.market,decoded.data.owner,
      decoded.data.id,programId);
    check(verified.address===recordAddress,'RECORD_PDA_MISMATCH');
    check(verified.data.state!==sdk.FreeState.Open,'RECORD_NOT_CLOSED');
    return verified;
  }
  return {
    async readFinalizedProof(recordAddress){
      const account=await recordAccount(recordAddress);
      return {proofComplete:account.data.proofComplete,proofHash:hex(account.data.proofHash)};
    },
    async sendCompleteInstruction({recordId,proofHash,instruction}){
      const account=await recordAccount(recordId);
      check(!account.data.proofComplete,'PROOF_ALREADY_COMPLETE');
      const built=await sdk.createCompleteProofInstruction({marketAddress:account.data.market,
        owner:account.data.owner,recordId:account.data.id,proofAuthority:proofAuthority.address,
        proofHash:Uint8Array.from(Buffer.from(proofHash,'hex'))},programId);
      check(built.recordAddress===recordId && hex(built.instruction.data)===hex(instruction.data),
        'COMPLETE_INSTRUCTION_MISMATCH');
      const prepared=await sdk.prepareUnsignedTransaction({transport,instruction:built.instruction,feePayer,programAddress:programId});
      const result=await sdk.submitAndConfirmFinalized({transport,prepared,expectedInstruction:built.instruction,
        sign,wait,attempts});
      if (result.state==='FAILED') throw new Error(result.reason);
      return {signature:result.signature,finalized:result.state==='FINALIZED'};
    }
  };
}

export function createKitMarketVersionReader({transport,programId,sdk=chainSdk}) {
  check(transport && programId);
  return {async getFinalizedVersions(marketAddress){
    const encoded=await transport.getFinalizedAccount(marketAddress);
    check(encoded?.exists===true && encoded.address===marketAddress && encoded.programAddress===programId,
      'MARKET_ACCOUNT_MISMATCH');
    const decoded=sdk.decodeMarket(encoded);
    const market=await sdk.readFinalizedMarket(transport,Uint8Array.from(decoded.data.id),programId);
    const config=await sdk.readFinalizedConfig(transport,programId);
    check(market.address===marketAddress,'MARKET_PDA_MISMATCH');
    return {source:'finalized-program-accounts',marketId:marketAddress,configAddress:config.address,
      schemaVersion:'0.1',formulaVersion:new TextDecoder('utf-8',{fatal:true})
        .decode(Uint8Array.from(config.data.formulaVersion)).replace(/\0+$/,''),
      configVersion:config.data.configVersion.toString(),queryVersion:market.data.queryVersion.toString(),
      queryHash:hex(market.data.queryHash)};
  }};
}
