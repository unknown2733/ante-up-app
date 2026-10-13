import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { address, decompileTransactionMessage, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS, AdmissionState, DataStatus, MarketPhase, PositionState,
  SPOT_BUY_DISCRIMINATOR, OPEN_PRO_DISCRIMINATOR, DEPOSIT_LP_DISCRIMINATOR, WITHDRAW_LP_DISCRIMINATOR,
  CLOSE_PRO_DISCRIMINATOR, CLAIM_PRO_DISCRIMINATOR, getSpotBuyInstructionDataDecoder, getOpenProInstructionDataDecoder,
  getDepositLpInstructionDataDecoder, getCloseProInstructionDataDecoder } from '../../../clients/chain/dist/index.js';
import { pro as proTerms, timeFee } from '../../../contracts/reference.mjs';
import { FinalizedFinancialAccounts, FirstSliceFinancialReader } from '../src/financial-chain.ts';
import { KitFirstSliceFinancialTransactionAdapter } from '../src/financial-transaction.ts';
import { SqliteFinancialRegistrationStore } from '../src/registration.ts';
import { validateFinancialIntent, validateFinancialQuote, validatePreparedFinancial } from '../src/financial.ts';
import type { MarketView } from '../../../contracts/types.ts';

const work=resolve(import.meta.dirname,'../../../../work/d-indexed-tests');mkdirSync(work,{recursive:true});
const programId=String(ANTE_UP_PROGRAM_ADDRESS),wallet='11111111111111111111111111111111';
const randomAddress=()=>getBase58Decoder().decode(randomBytes(32));
const marketId=randomAddress(),paymentMint=randomAddress(),keywordMint=randomAddress(),paymentVault=randomAddress(),inventory=randomAddress(),treasury=randomAddress(),paymentAta=randomAddress(),keywordAta=randomAddress();
const now=1_800_000_000,unit=1_000_000n;
const message=(base64:string)=>decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(base64,'base64')).messageBytes));

test('indexed spot, Pro open/close/claim and LP quotes compile B instructions with exact limits',async()=>{
  const store=new SqliteFinancialRegistrationStore(resolve(work,`${randomUUID()}.sqlite`));
  const hash='a'.repeat(64);
  const chainMarket={phase:MarketPhase.Indexed,dataStatus:DataStatus.Valid,admission:{state:AdmissionState.Open},
    latestSequence:7n,latestHash:Buffer.from(hash,'hex'),latestDataThrough:BigInt(now-50),
    latestNowQ12:{__option:'Some' as const,value:1_000_000_000_000n},latest7dQ12:{__option:'Some' as const,value:1_000_000_000_000n},validityGeneration:0n};
  const fm={market:address(marketId),keywordMint:address(keywordMint),vaultInventory:address(inventory),paymentVault:address(paymentVault),
    stateVersion:3n,anchorPg:unit,anchorSg:1_000_000_000_000n,anchorDg:1_000_000_000_000n,pmax:5n*unit,
    externalQ:0n,proReserved:0n,otherReserved:0n,totalShares:1_000n*unit,lockedShares:0n,openPositions:0,
    lpWindowStart:BigInt(now-100),lpWindowEnd:BigInt(now+800),proReopenAt:BigInt(now+800),currentMaturity:0n,
    currentCycle:0n,lastLpMaturity:BigInt(now),lpGeneration:0n};
  const finance={admin:address(wallet),paymentMint:address(paymentMint),protocolTreasury:address(treasury)};
  const state=({options:{cluster:'localnet' as const,programId,accounts:{async get(){return null;}}},
    async financeConfig(){return finance;},async config(){return {configVersion:4n};},async market(){return chainMarket;},async financeMarket(){return fm;},
    async mintAt(){return {supply:2_000n*unit};},async tokenAt(a:string,m:string,o:string){return {address:a,mint:m,owner:o,amount:100_000n*unit,exists:true};},
    async associatedToken(owner:string,mint:string){return {address:mint===paymentMint?paymentAta:keywordAta,owner,mint,amount:100_000n*unit,exists:true};},
    async holding(){return {address:programId,value:{market:address(marketId),owner:address(wallet),shares:500n*unit}};},
    async settlement(){return null;},async position(){return null;},async programAccounts(){return {slot:'7',accounts:[]};}}) as unknown as FinalizedFinancialAccounts;
  let wallNow=now;
  const reader=new FirstSliceFinancialReader(state,store,()=>wallNow);
  assert.ok((await reader.vault(marketId))?.value.navAtoms);
  fm.openPositions=1;
  assert.equal((await reader.vault(marketId))?.value.navAtoms,null);
  fm.openPositions=0;
  const tx=new KitFirstSliceFinancialTransactionAdapter({state,reader,blockhashes:{async latest(){return {blockhash:wallet,lastValidBlockHeight:999n};}},now:()=>wallNow});
  const snapshot={payload:{marketId,sequence:'7',dataThrough:now-50,configVersion:'4'},payloadHash:hash,finality:'finalized' as const};
  const market:MarketView={id:marketId,keyword:'test',aliases:[],phase:'INDEXED',dataStatus:'VALID',epochPhase:'LP_WINDOW',supported:true,
    chain:{cluster:'localnet',programId,address:marketId},snapshot:snapshot as any,anchor:null,
    price:{kind:'indexed',atoms:'1000000',executable:true},capabilities:{}};
  async function build(action:string,extra:Record<string,unknown>={}){
    const intent=validateFinancialIntent({requestId:randomUUID(),wallet,action,marketId,...extra});
    const quote=await reader.quote(intent,market,now);assert.ok(quote,action);
    validateFinancialQuote(quote,intent,market,{cluster:'localnet',programId,now:wallNow});
    const built=await validatePreparedFinancial(await tx.prepare(quote),quote,tx,{cluster:'localnet',programId,now:wallNow});
    return {quote,ix:message(built.prepared.unsignedTransaction).instructions.at(-1)!};
  }
  const spot=await build('spotBuy',{quantityAtoms:'1000000'});
  assert.deepEqual([...spot.ix.data!.subarray(0,8)],[...SPOT_BUY_DISCRIMINATOR]);
  assert.equal(getSpotBuyInstructionDataDecoder().decode(spot.ix.data!).expectedSequence,7n);
  assert.equal(getSpotBuyInstructionDataDecoder().decode(spot.ix.data!).maxPayment,BigInt(spot.quote.maxPaymentAtoms));
  const lp=await build('depositLP',{quantityAtoms:'1000000'});
  assert.deepEqual([...lp.ix.data!.subarray(0,8)],[...DEPOSIT_LP_DISCRIMINATOR]);
  assert.equal(getDepositLpInstructionDataDecoder().decode(lp.ix.data!).minShares,BigInt(lp.quote.minReceiveAtoms));
  const withdraw=await build('withdrawLP',{quantityAtoms:'1000000'});
  assert.deepEqual([...withdraw.ix.data!.subarray(0,8)],[...WITHDRAW_LP_DISCRIMINATOR]);
  fm.lpWindowStart=BigInt(now-1800);fm.lpWindowEnd=BigInt(now-900);fm.proReopenAt=BigInt(now-900);
  market.epochPhase='PRO_OPEN';
  const pro=await build('openPro',{collateralAtoms:'1000000',leverageBps:'20000',direction:'long'});
  assert.deepEqual([...pro.ix.data!.subarray(0,8)],[...OPEN_PRO_DISCRIMINATOR]);
  assert.equal(getOpenProInstructionDataDecoder().decode(pro.ix.data!).maxPayment,BigInt(pro.quote.maxPaymentAtoms));
  const positionAddress=randomAddress(),claimAddress=randomAddress(),settlementAddress=randomAddress();
  const opened={market:address(marketId),owner:address(wallet),id:1n,cycle:1n,direction:0,
    collateral:1_000_000n,notional:BigInt(pro.quote.grossAtoms),leverageBps:20_000n,entryPrice:unit,
    maximumPayout:BigInt(pro.quote.maxPayoutAtoms!),capital:BigInt(pro.quote.maxPayoutAtoms!)-1_000_000n,
    prepaidFee:BigInt(pro.quote.timePrepaidAtoms),openedAt:BigInt(now),maturity:BigInt(pro.quote.maturityAt!),state:PositionState.Open};
  (state as any).position=async()=>opened;
  (state as any).settlementAddress=async()=>settlementAddress;
  const close=await build('closePro',{positionId:positionAddress});
  assert.deepEqual([...close.ix.data!.subarray(0,8)],[...CLOSE_PRO_DISCRIMINATOR]);
  // Wallet latency must not violate the minimum receipt solely through earned fees.
  for (const direction of ['long','short'] as const) {
    const terms=proTerms(10n*unit,50_000n,unit,unit,fm.pmax,direction);
    Object.assign(opened,{direction:direction==='long'?0:1,collateral:10n*unit,leverageBps:50_000n,
      notional:terms.notional,maximumPayout:terms.reserve,capital:terms.capital,openedAt:BigInt(now-12345),maturity:BigInt(now+86400)});
    opened.prepaidFee=timeFee(opened.capital,opened.notional,opened.maturity-opened.openedAt,0n).prepaid;
    const delayed=await build('closePro',{positionId:positionAddress});
    const decoded=getCloseProInstructionDataDecoder().decode(delayed.ix.data!);
    assert.equal(decoded.minReceipt,BigInt(delayed.quote.minReceiveAtoms));
    assert.equal(decoded.deadline,BigInt(delayed.quote.expiresAt));
    assert.equal(decoded.expectedSequence,7n);
    assert.equal(decoded.expectedStateVersion,3n);
    const startDue=terms.payout+timeFee(opened.capital,opened.notional,opened.maturity-opened.openedAt,BigInt(now)-opened.openedAt).refund;
    assert.ok(decoded.minReceipt<startDue,'must allow the actual declining refund');
    for(let at=now;at<=delayed.quote.expiresAt;at++) {
      const actualDue=terms.payout+timeFee(opened.capital,opened.notional,opened.maturity-opened.openedAt,BigInt(at)-opened.openedAt).refund;
      assert.ok(actualDue>=decoded.minReceipt,`${direction} closes after ${at-now}s`);
    }
    opened.maturity=BigInt(now+10);
    opened.prepaidFee=timeFee(opened.capital,opened.notional,opened.maturity-opened.openedAt,0n).prepaid;
    const nearMaturity=await build('closePro',{positionId:positionAddress});
    assert.equal(nearMaturity.quote.expiresAt,now+9);
  }
  // A later sealing time must drive the refund bound as well as expiry.
  opened.maturity=BigInt(now+86400);
  opened.prepaidFee=timeFee(opened.capital,opened.notional,opened.maturity-opened.openedAt,0n).prepaid;
  wallNow=now+11;
  const sealedClose=await build('closePro',{positionId:positionAddress});
  assert.equal(sealedClose.quote.quotedAt,wallNow);
  assert.equal(sealedClose.quote.expiresAt,wallNow+30);
  const finalFee=timeFee(opened.capital,opened.notional,opened.maturity-opened.openedAt,BigInt(sealedClose.quote.expiresAt)-opened.openedAt);
  const finalTerms=proTerms(opened.collateral,opened.leverageBps,opened.entryPrice,unit,fm.pmax,'short');
  assert.equal(BigInt(sealedClose.quote.minReceiveAtoms),finalTerms.payout+finalFee.refund);
  wallNow=now+550; // dataThrough is now-50: precisely 600 seconds old after reads.
  await assert.rejects(()=>build('closePro',{positionId:positionAddress}),/DATA_NOT_READY/);
  wallNow=now+10;opened.maturity=BigInt(now+10);
  await assert.rejects(()=>build('closePro',{positionId:positionAddress}),/REQUOTE_REQUIRED/);
  wallNow=now;
  fm.otherReserved=100n*unit;
  opened.state=PositionState.Settled;
  (state as any).claimByAddress=async()=>({address:claimAddress,value:{market:address(marketId),owner:address(wallet),position:address(positionAddress),
    payout:1_000_000n,refund:1_000n,paid:false}});
  const claim=await build('claim',{claimId:claimAddress});
  assert.deepEqual([...claim.ix.data!.subarray(0,8)],[...CLAIM_PRO_DISCRIMINATOR]);
  assert.equal(claim.quote.snapshot,null);
  store.close();
});
