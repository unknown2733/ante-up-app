import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as k from '@solana/kit';
import {verifyMessageIntent} from '../src/receipt-intent.ts';
import {verifyReceipt} from '../src/operation-chain.ts';
const wallet=await k.generateKeyPairSigner();
const target=k.address('7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT');
const program=k.address('FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr');
const compute=k.address('ComputeBudget111111111111111111111111111111');
const base:k.Instruction={programAddress:program,accounts:[{address:wallet.address,role:k.AccountRole.WRITABLE_SIGNER},{address:target,role:k.AccountRole.WRITABLE}],data:Uint8Array.of(4,2,9)};
const limit=(n=200000):k.Instruction=>{const d=Buffer.alloc(5);d[0]=2;d.writeUInt32LE(n,1);return {programAddress:compute,data:d};};
const price=(n=375000n):k.Instruction=>{const d=Buffer.alloc(9);d[0]=3;d.writeBigUInt64LE(n,1);return {programAddress:compute,data:d};};
const build=(ix:readonly k.Instruction[],hash='11111111111111111111111111111111')=>k.compileTransaction(
 k.appendTransactionMessageInstructions(ix,k.setTransactionMessageLifetimeUsingBlockhash({blockhash:k.blockhash(hash),lastValidBlockHeight:10n},k.setTransactionMessageFeePayer(wallet.address,k.createTransactionMessage({version:0})))));
const expected=build([base]);
const check=(ix:readonly k.Instruction[])=>verifyMessageIntent(new Uint8Array(expected.messageBytes),new Uint8Array(build(ix).messageBytes));
test('accepts original message and wallet compute prefixes in either order',()=>{
 check([base]);check([price(),limit(),base]);check([limit(),price(),base]);check([limit(),base]);
 check([base,limit(),price()]);check([limit(),base,price()]);
});
test('rejects altered data, accounts, access privileges and extra instructions',()=>{
 for(const changed of [
  {...base,data:Uint8Array.of(4,2,10)},
  {...base,accounts:[{address:wallet.address,role:k.AccountRole.WRITABLE_SIGNER}]},
  {...base,accounts:[base.accounts![0],{address:target,role:k.AccountRole.READONLY}]},
 ])assert.throws(()=>check([limit(),changed]),/INTENT_MISMATCH/);
 assert.throws(()=>check([limit(),base,base]),/INTENT_MISMATCH/);
});
test('rejects unknown, duplicate, malformed or excessive compute settings',()=>{
 for(const ix of [
  [limit(),limit(),base],[{programAddress:compute,data:Uint8Array.of(1,0,0,0,0)},base],
  [{programAddress:compute,data:Uint8Array.of(2,0)},base],[limit(1400001),base],
  [price(5000001n),limit(),base],[{...limit(),accounts:base.accounts},base],
 ])assert.throws(()=>check(ix),/INTENT_MISMATCH/);
});
test('rejects replacement lifetime and payer',async()=>{
 const other=await k.generateKeyPairSigner();
 const tx=k.compileTransaction(k.appendTransactionMessageInstructions([limit(),base],k.setTransactionMessageLifetimeUsingBlockhash({blockhash:k.blockhash('11111111111111111111111111111111'),lastValidBlockHeight:10n},k.setTransactionMessageFeePayer(other.address,k.createTransactionMessage({version:0})))));
 assert.throws(()=>verifyMessageIntent(new Uint8Array(expected.messageBytes),new Uint8Array(tx.messageBytes)),/INTENT_MISMATCH/);
 assert.throws(()=>verifyMessageIntent(new Uint8Array(expected.messageBytes),new Uint8Array(build([limit(),base],'89XRWQQU76KWDnnq9wP8nJeYcW9Mg43TXax9qdDnMjR6').messageBytes)),/INTENT_MISMATCH/);
});
test('receipt still verifies actual wallet signature after allowed prefix',async()=>{
 const signed=await k.signTransactionWithSigners([wallet],build([price(),limit(),base]));
 const wire=k.getBase64Decoder().decode(k.getTransactionEncoder().encode(signed));
 const stored={intent:{wallet:wallet.address},prepared:{unsignedTransaction:k.getBase64Decoder().decode(k.getTransactionEncoder().encode(expected))}} as Parameters<typeof verifyReceipt>[0];
 verifyReceipt(stored,k.getSignatureFromTransaction(signed),{wireBase64:wire,status:'finalized'});
 const other=await k.signTransactionWithSigners([wallet],build([limit(),base]));
 assert.throws(()=>verifyReceipt(stored,k.getSignatureFromTransaction(other),{wireBase64:wire,status:'finalized'}),/SIGNATURE_MISMATCH/);
});
