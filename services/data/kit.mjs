import * as chainSdk from '../../clients/chain/dist/index.js';
import { hash } from './index.mjs';

const check=(ok,code='CHAIN_CONFIG_MISMATCH')=>{if(!ok)throw new Error(code);};
const hex=x=>Buffer.from(x).toString('hex');

// transport is B's createKitChainTransport(endpoint). sign is
// withKitSigner(publisherSigner); finalizedSnapshots is D's projection reader.
export function createKitPublisherChain({transport,programId,publisherSigner,feePayer,sign,finalizedSnapshots,
  wait,attempts,sdk=chainSdk}) {
  check(transport && programId && publisherSigner?.address && feePayer && typeof sign==='function' &&
    typeof finalizedSnapshots?.getFinalizedSnapshot==='function','PUBLISH_RUNTIME_CONFIG');
  return {
    async readPublishContext(market){
      const seed=Uint8Array.from(Buffer.from(market.seedHex,'hex'));
      check(seed.length===32,'MARKET_SEED_INVALID');
      const [config,chainMarket]=await Promise.all([
        sdk.readFinalizedConfig(transport,programId),sdk.readFinalizedMarket(transport,seed,programId)]);
      check(chainMarket.address===market.address && config.data.publisher===publisherSigner.address &&
        new TextDecoder().decode(Uint8Array.from(config.data.formulaVersion)).replace(/\0+$/,'')==='h3-d7-q12-v1',
        'PUBLISH_AUTHORITY_MISMATCH');
      return {sequence:(chainMarket.data.latestSequence+1n).toString(),
        configVersion:config.data.configVersion.toString(),queryVersion:chainMarket.data.queryVersion.toString(),
        queryHash:hex(chainMarket.data.queryHash),
        latestDataThrough:chainMarket.data.latestDataThrough.toString(),
        latestPayloadHash:hex(chainMarket.data.latestHash)};
    },
    async sendInstruction({instruction}){
      const prepared=await sdk.prepareUnsignedTransaction({transport,instruction,feePayer,programAddress:programId});
      const result=await sdk.submitAndConfirmFinalized({transport,prepared,expectedInstruction:instruction,sign,wait,attempts});
      if (result.state==='FAILED') throw new Error(result.reason);
      return {signature:result.signature,finalized:result.state==='FINALIZED'};
    },
    async readFinalizedSnapshot({market,sequence,payloadHash,signature,candidate}){
      const account=await sdk.readFinalizedSnapshot(transport,market.address,BigInt(sequence),programId)
        .catch(e=>e.message==='ACCOUNT_MISSING_OR_ADDRESS_MISMATCH'?null:Promise.reject(e));
      if (!account) return null;
      check(hex(account.data.payloadHash)===payloadHash && account.data.market===market.address &&
        account.data.sequence.toString()===sequence,'FINALITY_MISMATCH');
      const projected=await finalizedSnapshots.getFinalizedSnapshot(market.address,sequence);
      if (!projected) return null;
      check(projected.finality==='finalized' && projected.chain?.address===account.address &&
        projected.chain.programId===programId && projected.payloadHash===payloadHash &&
        (!signature || projected.signature===signature) && hash(projected.payload)===payloadHash &&
        hash(candidate)===payloadHash,'FINALITY_MISMATCH');
      return projected;
    }
  };
}
