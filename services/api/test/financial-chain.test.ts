import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { address, getAddressEncoder, getProgramDerivedAddress, getCompiledTransactionMessageDecoder, getTransactionDecoder, decompileTransactionMessage, getBase58Decoder } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS, MarketPhase, getCurveBuyInstructionDataDecoder, CURVE_BUY_DISCRIMINATOR,
  getClaimFaucetInstructionDataDecoder, findKeywordMintPda } from '../../../clients/chain/dist/index.js';
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM, FinalizedFinancialAccounts, FirstSliceFinancialReader } from '../src/financial-chain.ts';
import { KitFirstSliceFinancialTransactionAdapter } from '../src/financial-transaction.ts';
import { SqliteFinancialRegistrationStore, deriveRegistration } from '../src/registration.ts';
import { validateFinancialIntent, validateFinancialQuote, validatePreparedFinancial } from '../src/financial.ts';
import type { MarketView } from '../../../contracts/types.ts';

const work=resolve(import.meta.dirname,'../../../../work/d-financial-chain-tests');
mkdirSync(work,{recursive:true});
const randomAddress=()=>getBase58Decoder().decode(generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).subarray(-32));
const programId=String(ANTE_UP_PROGRAM_ADDRESS),wallet='11111111111111111111111111111111',paymentMint='So11111111111111111111111111111111111111112';
const now=1_800_000_000;

test('B quotes, registration reservation and prepared instructions share the confirmed-clock deadline',async()=>{
  const path=resolve(work,`${randomUUID()}.sqlite`);
  const store=new SqliteFinancialRegistrationStore(path);
  const registerIntent=validateFinancialIntent({requestId:randomUUID(),wallet,action:'registerMarket',marketId:null,keyword:'Dubai Chocolate',aliases:['#DubaiChocolate']});
  const entry=await deriveRegistration(registerIntent,programId);
  const marketId=entry.address;
  const [keywordMint]=await findKeywordMintPda({market:address(marketId)},{programAddress:address(programId)});
  const paymentAccount=randomAddress(),keywordAccount=randomAddress();
  const fm={market:address(marketId),keywordMint,curveInventory:address(randomAddress()),paymentVault:address(randomAddress()),stateVersion:2n,curveSold:0n};
  const finance={admin:address(wallet),paymentMint:address(paymentMint),protocolTreasury:address(wallet),faucetAmount:1_000_000_000n,faucetCooldown:86_400n,faucetTotalLimit:10_000_000_000n,faucetMinted:0n};
  // The account source is injected here; separate tests cover real PDA/owner/discriminator readers.
  const state=({options:{cluster:'localnet' as const,programId,accounts:{async get(){return null;}}},
    async financeConfig(){return finance;},async mintAt(){return {supply:0n};},async receipt(){return null;},
    async associatedToken(owner:string,mint:string){return {address:mint===paymentMint?paymentAccount:keywordAccount,owner,mint,amount:100_000_000_000n};},
    async market(){return {phase:MarketPhase.Curve,latestSequence:7n};},async financeMarket(){return fm;},
    async config(){return {configVersion:3n};},async tokenAt(a:string,m:string,o:string){return {address:a,mint:m,owner:o,amount:100_000_000_000n};}}) as unknown as FinalizedFinancialAccounts;
  let clockTime=now-1;
  const reader=new FirstSliceFinancialReader(state,store,()=>now,async()=>({unixTimestamp:clockTime,observedAt:now}));
  const tx=new KitFirstSliceFinancialTransactionAdapter({state,reader,blockhashes:{async latest(){return {blockhash:wallet,lastValidBlockHeight:999n};}},now:()=>now});
  const faucetIntent=validateFinancialIntent({requestId:randomUUID(),wallet,action:'faucet',marketId:null});
  const faucet=await reader.quote(faucetIntent,null,now);
  assert.ok(faucet);
  const faucetBuilt=await validatePreparedFinancial(await tx.prepare(faucet),faucet,tx,{cluster:'localnet',programId,now});
  const faucetMessage=decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(faucetBuilt.prepared.unsignedTransaction,'base64')).messageBytes));
  assert.equal(faucetMessage.instructions.length,1);
  assert.ok(getClaimFaucetInstructionDataDecoder().decode(faucetMessage.instructions[0].data!).discriminator);
  const registration=await reader.quote(registerIntent,null,now);
  assert.ok(registration);
  assert.equal(registration.expiresAt,now+28);
  const db=new DatabaseSync(path,{readOnly:true});
  assert.equal(db.prepare('SELECT expires_at FROM financial_registrations WHERE request_id=?').get(registerIntent.requestId)?.expires_at,registration.expiresAt);
  db.close();
  assert.equal(registration.chain.address,marketId);
  assert.equal(store.pending(registerIntent.requestId)?.queryHash,entry.queryHash);
  const registerBuilt=await validatePreparedFinancial(await tx.prepare(registration),registration,tx,{cluster:'localnet',programId,now});
  assert.equal(registerBuilt.discoveryAddress,marketId);
  const curveIntent=validateFinancialIntent({requestId:randomUUID(),wallet,action:'curveBuy',marketId,quantityAtoms:'1000000'});
  const market:MarketView={id:marketId,keyword:entry.keyword,aliases:entry.aliases,phase:'CURVE',dataStatus:'OUTAGE',epochPhase:null,supported:true,
    chain:{cluster:'localnet',programId,address:marketId},snapshot:null,anchor:null,price:null,capabilities:{}};
  const quote=await reader.quote(curveIntent,market,now);
  assert.ok(quote);
  validateFinancialQuote(quote,curveIntent,market,{cluster:'localnet',programId,now});
  const built=await validatePreparedFinancial(await tx.prepare(quote),quote,tx,{cluster:'localnet',programId,now});
  const message=decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(built.prepared.unsignedTransaction,'base64')).messageBytes));
  assert.ok(Buffer.from(message.instructions[0].data!.subarray(0,8)).equals(Buffer.from(CURVE_BUY_DISCRIMINATOR)));
  const data=getCurveBuyInstructionDataDecoder().decode(message.instructions[0].data!);
  assert.equal(data.quantity,1_000_000n);
  assert.equal(data.expectedSequence,0n);
  assert.equal(data.expectedConfigVersion,3n);
  assert.equal(data.expectedStateVersion,2n);
  assert.equal(data.maxPayment,BigInt(quote.maxPaymentAtoms));
  assert.equal(data.deadline,BigInt(quote.expiresAt));
  assert.equal(built.prepared.expiresAt,quote.expiresAt);
  assert.ok(data.deadline<=BigInt(clockTime+30));
  // A new quote must sample the chain again; no stale deadline cached across requotes.
  clockTime=now-2;
  const requote=await reader.quote({...curveIntent,requestId:randomUUID()},market,now);
  assert.equal(requote?.expiresAt,now+27);
  clockTime=now-11;
  await assert.rejects(()=>reader.quote({...curveIntent,requestId:randomUUID()},market,now),/REQUOTE_REQUIRED/);
  clockTime=now-1;
  assert.equal(await reader.quote(validateFinancialIntent({requestId:randomUUID(),wallet,action:'spotBuy',marketId,quantityAtoms:'1'}),market,now),null);
  store.close();
});

test('fresh wallet creates payment ATA for faucet and keyword ATA for first curve buy',async()=>{
  const store=new SqliteFinancialRegistrationStore(resolve(work,`${randomUUID()}.sqlite`));
  const entry=await deriveRegistration(validateFinancialIntent({requestId:randomUUID(),wallet,action:'registerMarket',marketId:null,keyword:'Fresh keyword',aliases:[]}),programId);
  const [keywordMint]=await findKeywordMintPda({market:address(entry.address)},{programAddress:address(programId)});
  const paymentAccount=randomAddress(),keywordAccount=randomAddress();
  let paymentExists=false;
  const finance={admin:address(wallet),paymentMint:address(paymentMint),protocolTreasury:address(wallet),faucetAmount:1_000_000_000n,faucetCooldown:86_400n,faucetTotalLimit:10_000_000_000n,faucetMinted:0n};
  const fm={market:address(entry.address),keywordMint,curveInventory:address(randomAddress()),paymentVault:address(randomAddress()),stateVersion:2n,curveSold:0n};
  const state=({options:{cluster:'localnet' as const,programId,accounts:{async get(){return null;}}},
    async financeConfig(){return finance;},async mintAt(){return {supply:0n};},async receipt(){return null;},
    async associatedToken(owner:string,mint:string){const payment=mint===paymentMint;return {address:payment?paymentAccount:keywordAccount,owner,mint,amount:payment&&paymentExists?100_000_000_000n:0n,exists:payment?paymentExists:false};},
    async market(){return {phase:MarketPhase.Curve,latestSequence:7n};},async financeMarket(){return fm;},
    async config(){return {configVersion:3n};},async tokenAt(a:string,m:string,o:string){return {address:a,mint:m,owner:o,amount:100_000_000_000n,exists:true};}}) as unknown as FinalizedFinancialAccounts;
  const reader=new FirstSliceFinancialReader(state,store);
  const tx=new KitFirstSliceFinancialTransactionAdapter({state,reader,blockhashes:{async latest(){return {blockhash:wallet,lastValidBlockHeight:999n};}},now:()=>now});
  const faucetIntent=validateFinancialIntent({requestId:randomUUID(),wallet,action:'faucet',marketId:null});
  const faucet=await reader.quote(faucetIntent,null,now);
  assert.ok(faucet);
  const faucetBuilt=await validatePreparedFinancial(await tx.prepare(faucet),faucet,tx,{cluster:'localnet',programId,now});
  const faucetMessage=decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(faucetBuilt.prepared.unsignedTransaction,'base64')).messageBytes));
  assert.equal(faucetMessage.instructions.length,2);
  assert.equal(String(faucetMessage.instructions[0].programAddress),ASSOCIATED_TOKEN_PROGRAM);
  assert.deepEqual([...faucetMessage.instructions[0].data!],[1]);
  assert.deepEqual(faucetMessage.instructions[0].accounts?.map(a=>String(a.address)),[wallet,paymentAccount,wallet,paymentMint,'11111111111111111111111111111111',TOKEN_PROGRAM]);
  paymentExists=true;
  const curveIntent=validateFinancialIntent({requestId:randomUUID(),wallet,action:'curveBuy',marketId:entry.address,quantityAtoms:'1000000'});
  const market:MarketView={id:entry.address,keyword:entry.keyword,aliases:entry.aliases,phase:'CURVE',dataStatus:'OUTAGE',epochPhase:null,supported:true,
    chain:{cluster:'localnet',programId,address:entry.address},snapshot:null,anchor:null,price:null,capabilities:{}};
  const curve=await reader.quote(curveIntent,market,now);
  assert.ok(curve);
  const curveBuilt=await validatePreparedFinancial(await tx.prepare(curve),curve,tx,{cluster:'localnet',programId,now});
  const curveMessage=decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(curveBuilt.prepared.unsignedTransaction,'base64')).messageBytes));
  assert.equal(curveMessage.instructions.length,2);
  assert.equal(String(curveMessage.instructions[0].programAddress),ASSOCIATED_TOKEN_PROGRAM);
  assert.deepEqual(curveMessage.instructions[0].accounts?.map(a=>String(a.address)),[wallet,keywordAccount,wallet,String(keywordMint),'11111111111111111111111111111111',TOKEN_PROGRAM]);
  assert.ok(Buffer.from(curveMessage.instructions[1].data!.subarray(0,8)).equals(Buffer.from(CURVE_BUY_DISCRIMINATOR)));
  store.close();
});

test('finalized ATA reader treats absence as zero and rejects invalid or frozen accounts',async()=>{
  const [ata]=await getProgramDerivedAddress({programAddress:address(ASSOCIATED_TOKEN_PROGRAM),seeds:[
    getAddressEncoder().encode(address(wallet)),getAddressEncoder().encode(address(TOKEN_PROGRAM)),getAddressEncoder().encode(address(paymentMint))]});
  let raw:{ownerProgramId:string;data:Uint8Array}|null=null;
  const state=new FinalizedFinancialAccounts({cluster:'localnet',programId,accounts:{async get(a){assert.equal(a,String(ata));return raw;}}});
  assert.deepEqual(await state.associatedToken(wallet,paymentMint),{address:String(ata),owner:wallet,mint:paymentMint,amount:0n,exists:false});
  const bytes=Buffer.alloc(165);
  getAddressEncoder().encode(address(paymentMint)).forEach((v,i)=>{bytes[i]=v;});
  getAddressEncoder().encode(address(wallet)).forEach((v,i)=>{bytes[32+i]=v;});
  bytes.writeBigUInt64LE(123n,64);
  bytes[108]=1;
  raw={ownerProgramId:TOKEN_PROGRAM,data:bytes};
  assert.equal((await state.associatedToken(wallet,paymentMint)).amount,123n);
  raw={ownerProgramId:programId,data:bytes};
  await assert.rejects(()=>state.associatedToken(wallet,paymentMint),/TOKEN_ACCOUNT_UNAVAILABLE/);
  bytes[108]=2;
  raw={ownerProgramId:TOKEN_PROGRAM,data:bytes};
  await assert.rejects(()=>state.associatedToken(wallet,paymentMint),/TOKEN_ACCOUNT_UNAVAILABLE/);
  bytes[108]=1;
  bytes[32]=1;
  await assert.rejects(()=>state.associatedToken(wallet,paymentMint),/TOKEN_ACCOUNT_IDENTITY_MISMATCH/);
});
