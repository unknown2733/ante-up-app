import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { address, appendTransactionMessageInstruction, compileTransaction, createTransactionMessage, decompileTransactionMessage,
  getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import type { FinancialQuote } from '../../../contracts/financial.ts';
import { createApp } from '../src/app.ts';
import { LiveStore } from '../src/live-store.ts';
import type { FinancialReader, FinancialTransactionAdapter } from '../src/financial.ts';
import type { ChainReceipt, OperationChain } from '../src/operation-chain.ts';

const work=resolve(import.meta.dirname,'../../../../work/d-financial-tests');
mkdirSync(work,{recursive:true});
const base='http://local.test';
const programId='11111111111111111111111111111111';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const wallet=getBase58Decoder().decode(publicKey.export({format:'der',type:'spki'}).subarray(-32));
const blockhash=programId;
let now=1_800_000_000;
const read={mode:'localnet' as const,async markets(){return [];},async records(){return [];},async proofs(){return [];},async heldCalculationWallets(){return new Set<string>();}};
const financial:FinancialReader={async portfolio(){return null;},async vault(){return null;},async quote(intent,market,at){
  assert.equal(market,null);
  return {id:randomUUID(),intent,chain:{cluster:'localnet',programId,address:programId},phase:null,quotedAt:at,expiresAt:at+30,
    configVersion:'1',snapshot:null,stateVersion:'1',priceAtoms:'0',grossAtoms:'0',tradeFeeAtoms:'0',timePrepaidAtoms:'0',
    maxPaymentAtoms:'0',minReceiveAtoms:'1000000000',maxPayoutAtoms:null,maturityAt:null,executable:true};
}};
const discriminator=Uint8Array.of(17,34,51,68,85,102,119,136);
const transactions:FinancialTransactionAdapter={
  async prepare(quote:FinancialQuote){
    const message=appendTransactionMessageInstruction({programAddress:address(programId),data:Uint8Array.from([...discriminator,...Buffer.from(quote.intent.requestId,'utf8')])},
      setTransactionMessageLifetimeUsingBlockhash({blockhash, lastValidBlockHeight:999n},
        setTransactionMessageFeePayer(address(quote.intent.wallet),createTransactionMessage({version:0}))));
    const unsignedTransaction=Buffer.from(getTransactionEncoder().encode(compileTransaction(message))).toString('base64');
    return {prepared:{kind:'transaction' as const,action:quote.intent.action,requestId:quote.intent.requestId,wallet:quote.intent.wallet,
      cluster:'localnet' as const,programId,expiresAt:quote.expiresAt,unsignedTransaction,lastValidBlockHeight:'999',quote},discoveryAddress:quote.intent.wallet};
  },
  async verifyCompiled(prepared,quote){
    const transaction=getTransactionDecoder().decode(Buffer.from(prepared.unsignedTransaction,'base64'));
    const message=decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(transaction.messageBytes));
    if (message.instructions.length!==1 || !message.instructions[0].data ||
        !Buffer.from(message.instructions[0].data).equals(Buffer.from([...discriminator,...Buffer.from(quote.intent.requestId,'utf8')]))) throw new Error('B_GENERATED_INSTRUCTION_MISMATCH');
  }
};
const receipts=new Map<string,ChainReceipt>();
const seenDiscovery:string[]=[];
const chain:OperationChain={async get(signature){return receipts.get(signature)??null;},async discover(address){
  seenDiscovery.push(address);return [...receipts].map(([signature,receipt])=>({signature,receipt}));
}};
const json=async(r:Response)=>r.json() as Promise<any>;
const post=(api:ReturnType<typeof createApp>,path:string,body:unknown,token:string)=>api.handle(new Request(`${base}${path}`,{
  method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)}));
const signedWire=(unsigned:string)=>{
  const transaction=getTransactionDecoder().decode(Buffer.from(unsigned,'base64'));
  const sig=sign(null,Buffer.from(transaction.messageBytes),privateKey);
  return {signature:getBase58Decoder().decode(sig),wireBase64:Buffer.from(getTransactionEncoder().encode({...transaction,signatures:{...transaction.signatures,[wallet]:sig}} as any)).toString('base64')};
};

test('injected exact financial builder persists preparation and recovers verified receipt after restart',async()=>{
  const db=resolve(work,`${randomUUID()}.sqlite`);
  let store=new LiveStore(db);
  const make=()=>createApp({mode:'localnet',programId,read,financial,financialTransactions:transactions,liveStore:store,chain,now:()=>now,verifier:{async verify(){return true;}}});
  let api=make();
  const challenge=(await json(await api.handle(new Request(`${base}/v1/auth`,{method:'POST',body:JSON.stringify({wallet,cluster:'localnet'})})))).data;
  const token=(await json(await api.handle(new Request(`${base}/v1/auth/session`,{method:'POST',body:JSON.stringify({wallet,cluster:'localnet',nonce:challenge.nonce,signature:'test'})})))).data.token;
  const requestId=randomUUID(),intent={action:'faucet',marketId:null,wallet,requestId};
  const unwired=createApp({mode:'localnet',programId,read,financial,liveStore:store,chain,now:()=>now,verifier:{async verify(){return true;}}});
  assert.equal((await json(await post(unwired,'/v1/financial/quotes',intent,token))).data.kind,'notExecutable');
  assert.equal(store.getFinancialQuote(requestId),null);
  const quoted=(await json(await post(api,'/v1/financial/quotes',intent,token))).data;
  assert.equal(quoted.kind,'quote');
  const quote=quoted.quote as FinancialQuote;
  const duplicate=(await json(await post(api,'/v1/financial/quotes',{requestId,wallet,marketId:null,action:'faucet'},token))).data;
  assert.equal(duplicate.quote.id,quote.id);
  const prepare={wallet,requestId,quoteId:quote.id};
  const prepared=(await json(await post(api,'/v1/financial/transactions/prepare',prepare,token))).data;
  assert.equal(prepared.kind,'transaction');
  assert.equal(prepared.recordId,undefined);
  assert.equal(store.get(requestId)?.kind,'financial');
  assert.equal(store.get(requestId)?.discoveryAddress,wallet);
  store.close();store=new LiveStore(db);api=make();
  const retry=(await json(await post(api,'/v1/financial/transactions/prepare',prepare,token))).data;
  assert.deepEqual(retry,prepared);
  const altered=await post(api,'/v1/financial/transactions/prepare',{...prepare,quoteId:randomUUID()},token);
  assert.equal(altered.status,409);
  const signed=signedWire(prepared.unsignedTransaction);
  const submitted=(await json(await post(api,`/v1/financial/operations/${requestId}/submit`,{wallet,signature:signed.signature},token))).data;
  assert.equal(submitted.state,'UNKNOWN');
  receipts.set(signed.signature,{wireBase64:signed.wireBase64,status:'finalized'});
  const settled=(await json(await api.handle(new Request(`${base}/v1/financial/operations/${requestId}?wallet=${wallet}`,{headers:{authorization:`Bearer ${token}`}})))).data;
  assert.equal(settled.state,'FINALIZED');
  assert.equal(settled.signature,signed.signature);
  const secondId=randomUUID(),secondQuote=(await json(await post(api,'/v1/financial/quotes',{...intent,requestId:secondId},token))).data.quote;
  const second=(await json(await post(api,'/v1/financial/transactions/prepare',{wallet,requestId:secondId,quoteId:secondQuote.id},token))).data;
  const foundWire=signedWire(second.unsignedTransaction);
  receipts.set(foundWire.signature,{wireBase64:foundWire.wireBase64,status:'finalized'});
  const found=(await json(await api.handle(new Request(`${base}/v1/financial/operations/${secondId}?wallet=${wallet}`,{headers:{authorization:`Bearer ${token}`}})))).data;
  assert.equal(found.state,'FINALIZED');
  assert.equal(seenDiscovery.at(-1),wallet);
  store.close();
});

test('older Free operation rows gain an explicit discovery address on startup',()=>{
  const path=resolve(work,`${randomUUID()}.sqlite`);
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE live_operations(request_id TEXT PRIMARY KEY,wallet TEXT NOT NULL,action TEXT NOT NULL,intent_json TEXT NOT NULL,prepared_json TEXT NOT NULL,message_base64 TEXT NOT NULL UNIQUE,state TEXT NOT NULL,signature TEXT UNIQUE,error_json TEXT)');
  const id=randomUUID();
  const intent={wallet,action:'openFree',requestId:id,marketId:programId,recordId:null};
  const prepared={kind:'transaction',action:'openFree',requestId:id,wallet,cluster:'localnet',programId,expiresAt:now+30,recordId:programId,unsignedTransaction:'AA==',lastValidBlockHeight:'1',quoteRef:null};
  db.prepare("INSERT INTO live_operations(request_id,wallet,action,intent_json,prepared_json,message_base64,state) VALUES(?,?,?,?,?,?,'AWAITING_SIGNATURE')")
    .run(id,wallet,'openFree',JSON.stringify(intent),JSON.stringify(prepared),'legacy-message');
  db.close();
  const store=new LiveStore(path);
  assert.equal(store.get(id)?.kind,'free');
  assert.equal(store.get(id)?.discoveryAddress,programId);
  store.close();
});
