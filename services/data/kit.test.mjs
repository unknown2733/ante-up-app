import test from 'node:test';
import assert from 'node:assert/strict';
import { createKitPublisherChain } from './kit.mjs';
import { hash } from './index.mjs';

test('Kit publisher reads finalized config/market and checks projected snapshot',async()=>{
  const address='1'.repeat(32),programId='2'.repeat(32),candidate={marketId:address,sequence:'5'};
  const payloadHash=hash(candidate),queryHash='a'.repeat(64);
  const market={address,logicalId:'phrase',seedHex:'01'.repeat(32),cluster:'localnet',programId};
  const projected={payload:candidate,payloadHash,finality:'finalized',signature:'sig',
    chain:{cluster:'localnet',programId,address:'snapshot'}};
  const sdk={readFinalizedConfig:async()=>({data:{publisher:address,formulaVersion:
    Uint8Array.from([...Buffer.from('h3-d7-q12-v1'),...new Uint8Array(4)]),configVersion:2n}}),
    readFinalizedMarket:async()=>({address,data:{latestSequence:4n,queryVersion:1n,
      queryHash:Uint8Array.from(Buffer.from(queryHash,'hex')),latestDataThrough:123n,
      latestHash:Uint8Array.from(Buffer.from('b'.repeat(64),'hex'))}}),
    readFinalizedSnapshot:async()=>({address:'snapshot',data:{market:address,sequence:5n,
      payloadHash:Uint8Array.from(Buffer.from(payloadHash,'hex'))}}),
    prepareUnsignedTransaction:async()=>({unsignedTransaction:'wire'}),
    submitAndConfirmFinalized:async()=>({state:'FINALIZED',signature:'sig'})};
  const chain=createKitPublisherChain({transport:{},programId,publisherSigner:{address},feePayer:address,
    sign:async()=>{},finalizedSnapshots:{getFinalizedSnapshot:async()=>projected},sdk});
  assert.deepEqual(await chain.readPublishContext(market),{sequence:'5',configVersion:'2',queryVersion:'1',queryHash,
    latestDataThrough:'123',latestPayloadHash:'b'.repeat(64)});
  assert.deepEqual(await chain.sendInstruction({instruction:{programAddress:programId}}),{signature:'sig',finalized:true});
  assert.deepEqual(await chain.readFinalizedSnapshot({market,sequence:'5',payloadHash,signature:'sig',candidate}),projected);
  await assert.rejects(()=>chain.readFinalizedSnapshot({market,sequence:'5',payloadHash:'0'.repeat(64),candidate}),/FINALITY_MISMATCH/);
});
