import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { address, createNoopSigner, generateKeyPairSigner, getBase58Decoder, getBase64Encoder,
  getSignatureFromTransaction, getTransactionDecoder } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS, MarketPhase, PositionDirection, PositionState, SettlementMode,
  ACCEPT_SETTLEMENT_DISCRIMINATOR, SETTLE_PRO_DISCRIMINATOR, START_LP_WINDOW_DISCRIMINATOR,
  getAcceptSettlementInstructionDataDecoder, getProPositionEncoder,
  getStartLpWindowInstructionAsync } from '../../../clients/chain/dist/index.js';
import { KitFinancialEpochChain } from '../src/keeper-chain.ts';
import {KitKeeperInstructionTransport} from '../src/keeper-transport.ts';
import type { FinalizedFinancialAccounts, FirstSliceFinancialReader } from '../src/financial-chain.ts';
import type { AcceptedCandidate, SettlementScope } from '../../keeper/src/candidate.ts';

const randomAddress=()=>getBase58Decoder().decode(randomBytes(32));
const programId=String(ANTE_UP_PROGRAM_ADDRESS),marketId=randomAddress(),positionAddress=randomAddress(),
  settlementAddress=randomAddress(),publisher=randomAddress(),keeper=randomAddress(),claimAddress=randomAddress();
const maturity=1_800_057_600,openedAt=1_800_000_000;
const scope:SettlementScope={cluster:'localnet',programId,marketId,epoch:'2',epochStartedAt:openedAt,maturityAt:maturity,
  queryHash:'a'.repeat(64),queryVersion:'1',configVersion:'4',anchor:{graduationPriceAtoms:'1000000',graduationNowQ12:'1000000000000',graduation7dQ12:'1000000000000',maxPriceAtoms:'5000000'}};

test('B keeper adapter verifies finalized cycle then builds accept, settle and LP instructions',async()=>{
  const position={market:address(marketId),owner:address(keeper),id:9n,cycle:2n,direction:PositionDirection.Long,
    collateral:1_000_000n,notional:2_000_000n,leverageBps:20_000n,entryPrice:1_000_000n,maximumPayout:5_000_000n,
    capital:4_000_000n,prepaidFee:1000n,openedAt:BigInt(openedAt),maturity:BigInt(maturity),
    state:PositionState.Open,settlementPrice:0n};
  const fm={currentCycle:2n,currentMaturity:BigInt(maturity),openPositions:1,totalShares:1_000n,
    lpWindowStart:1n,lpWindowEnd:2n,anchorPg:1_000_000n,anchorSg:1_000_000_000_000n,
    anchorDg:1_000_000_000_000n,pmax:5_000_000n};
  const market={phase:MarketPhase.Indexed,queryVersion:1n,queryHash:Uint8Array.from(Buffer.from('a'.repeat(64),'hex'))};
  let settlement:null|{address:string;value:any}=null;
  const state=({options:{cluster:'localnet' as const,programId},async config(){return {publisher:address(publisher),configVersion:4n};},
    async market(){return market;},async financeMarket(){return fm;},async settlement(){return settlement;},
    async settlementAddress(){return settlementAddress;},async position(){return position;},async claim(){return null;},
    async snapshot(){return {market:address(marketId),sequence:7n,payloadHash:new Uint8Array(32).fill(9),
      queryHash:market.queryHash,queryVersion:1n,dataThrough:BigInt(maturity-100_000),publishedAt:BigInt(maturity-100_001),
      activityNowQ12:{__option:'Some',value:1_000_000_000_000n},
      activity7dQ12:{__option:'Some',value:1_000_000_000_000n}};},
    async programAccounts(){return {slot:'77',accounts:[{address:positionAddress,ownerProgramId:programId,
      data:getProPositionEncoder().encode(position)}]};}}) as unknown as FinalizedFinancialAccounts;
  const reader=({async vault(){return {value:{navAtoms:'1000000'}};}}) as unknown as FirstSliceFinancialReader;
  const sent:Array<{authority:string;ix:any}>=[];
  const transport={publisherAddress:publisher,keeperAddress:keeper,async send(ix:any,authority:'publisher'|'keeper'){
    sent.push({authority,ix});return `${authority}-sig`;},async signatureStatus(){return 'PENDING' as const;}};
  const chain=new KitFinancialEpochChain(state,reader,transport,scope);
  const read=await chain.read(scope);
  assert.equal(read.cycle,'2');assert.equal(read.epochStartedAt,openedAt);assert.equal(read.openPositionCount,1);
  const candidate:AcceptedCandidate={marketId,epoch:2n,maturityAt:BigInt(maturity),candidateHash:new Uint8Array(32).fill(7),
    evidenceHash:new Uint8Array(32).fill(8),mode:'NORMAL',eligibleAt:BigInt(maturity+900),effectiveCloseAt:BigInt(maturity),
    outageStartedAt:0n,settlementPrice:1_000_000n,activityNowQ12:1_000_000_000_000n,activity7dQ12:1_000_000_000_000n,
    queryVersion:1n,configVersion:4n,dataThrough:maturity};
  assert.equal(await chain.accept(candidate),'publisher-sig');
  assert.deepEqual([...sent[0].ix.data.subarray(0,8)],[...ACCEPT_SETTLEMENT_DISCRIMINATOR]);
  assert.equal(getAcceptSettlementInstructionDataDecoder().decode(sent[0].ix.data).epoch,2n);
  const emergency:AcceptedCandidate={...candidate,mode:'EMERGENCY',outageStartedAt:BigInt(maturity-100_000),
    dataThrough:maturity-100_000,emergencySnapshot:{sequence:7n,payloadHash:new Uint8Array(32).fill(9),
      publishedAt:maturity-100_001}};
  assert.equal(await chain.accept(emergency),'publisher-sig');
  await assert.rejects(chain.accept({...emergency,emergencySnapshot:{sequence:7n,
    payloadHash:new Uint8Array(32).fill(8),publishedAt:maturity-100_001}}),/KEEPER_EMERGENCY_SNAPSHOT_MISMATCH/);
  settlement={address:settlementAddress,value:{market:address(marketId),cycle:2n,epoch:2n,maturityAt:BigInt(maturity),
    candidateHash:candidate.candidateHash,evidenceHash:candidate.evidenceHash,mode:SettlementMode.Normal,
    eligibleAt:BigInt(maturity+900),effectiveCloseAt:BigInt(maturity),acceptedAt:BigInt(maturity+900),price:1_000_000n}};
  assert.equal(await chain.settle(marketId,positionAddress),'keeper-sig');
  assert.deepEqual([...sent[2].ix.data.subarray(0,8)],[...SETTLE_PRO_DISCRIMINATOR]);
  fm.openPositions=0;
  assert.equal(await chain.startLpWindow(marketId),'publisher-sig');
  assert.deepEqual([...sent[3].ix.data.subarray(0,8)],[...START_LP_WINDOW_DISCRIMINATOR]);
  settlement=null;fm.currentMaturity=0n;
  assert.equal(await chain.startLpWindow(marketId),'publisher-sig');
  assert.equal(String(sent[4].ix.accounts[3].address),settlementAddress);
});

test('keeper signer transport signs one generated instruction and returns its signature',async()=>{
  const signer=await generateKeyPairSigner();
  const ix=await getStartLpWindowInstructionAsync({market:address(marketId),settlement:address(settlementAddress),
    publisher:createNoopSigner(signer.address)},{programAddress:address(programId)});
  let sends=0,signed:string|null=null;
  const rpc={async getLatestBlockhash(){return {blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n};},
    async getBlockHeight(){return 1n;},async isBlockhashValid(){return true;},
    async sendTransaction(wire:string){sends++;assert.ok(signed);return getSignatureFromTransaction(
      getTransactionDecoder().decode(getBase64Encoder().encode(wire)));},
    async getSignatureStatus(){return {confirmationStatus:'finalized',err:null};}};
  const transport=new KitKeeperInstructionTransport({endpoint:'http://localhost:8899',programId,
    publisher:signer,keeper:signer,rpc:rpc as any});
  const signature=await transport.send(ix,'publisher',value=>{signed=value;});
  assert.equal(signature,signed);assert.equal(sends,1);
  assert.equal(await transport.signatureStatus(signature),'FINALIZED');
});
