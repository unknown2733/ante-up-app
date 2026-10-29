import test from 'node:test';
import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import { AdmissionReason, AdmissionState, DataStatus, MarketPhase, findSnapshotPda, getMarketEncoder, getSnapshotEncoder, ANTE_UP_PROGRAM_ADDRESS } from '../../../clients/chain/dist/index.js';
import { fixtureMarkets } from '../../api/src/fixture.ts';
import { KitFinalizedAccountReader, SqliteEventRepositories } from '../src/repositories.ts';
import { verifyPublishedSnapshot } from '../src/snapshot.ts';

test('candidate repository resolves immutable B account by PDA, owner and hash',async()=>{
  const programId=String(ANTE_UP_PROGRAM_ADDRESS),marketAddress='11111111111111111111111111111111';
  const scope={cluster:'localnet' as const,programId,address:programId};
  const candidate=structuredClone(fixtureMarkets[0].snapshot!.payload);
  candidate.marketId=marketAddress;
  const [pda]=await findSnapshotPda({market:address(marketAddress),sequence:BigInt(candidate.sequence)},{programAddress:address(programId)});
  let ownerProgramId=programId;
  let data=new Uint8Array();
  const repositories=new SqliteEventRepositories(':memory:',{async get(id){return id===String(pda)?{ownerProgramId,data}:null;}});
  const hash=repositories.putCandidate(scope,marketAddress,candidate);
  const reordered=Object.fromEntries(Object.entries(candidate).reverse()) as typeof candidate;
  assert.equal(repositories.putCandidate(scope,marketAddress,reordered),hash);
  const version=new Uint8Array(16);version.set(new TextEncoder().encode(candidate.formulaVersion));
  data=getSnapshotEncoder().encode({market:address(marketAddress),sequence:BigInt(candidate.sequence),
    payloadHash:Uint8Array.from(Buffer.from(hash,'hex')),evidenceHash:Uint8Array.from(Buffer.from(candidate.evidenceHash,'hex')),
    queryHash:Uint8Array.from(Buffer.from(candidate.queryHash,'hex')),queryVersion:BigInt(candidate.queryVersion),
    configVersion:BigInt(candidate.configVersion),formulaVersion:version,dataThrough:BigInt(candidate.dataThrough),
    publishedAt:BigInt(candidate.computedAt),activityNowQ12:BigInt(candidate.activityNowQ12!),
    activity7dQ12:BigInt(candidate.activity7dQ12!),dataStatus:DataStatus.Valid,
    admission:{state:AdmissionState.Blocked,recoveryCount:0,reason:AdmissionReason.PendingConfirmation}});
  const resolved=await repositories.resolve({marketAddress,sequence:candidate.sequence,payloadHash:hash,scope});
  assert.equal(verifyPublishedSnapshot({cluster:'localnet',programId,signature:'sig',slot:'1',marketAddress,
    marketId:marketAddress,sequence:candidate.sequence,eventPayloadHash:hash,
    candidate:resolved.candidate,account:resolved.account}).payloadHash,hash);
  assert.equal(resolved.account.address,String(pda));
  assert.equal(resolved.candidate.marketId,marketAddress);
  await assert.rejects(repositories.resolve({marketAddress,sequence:candidate.sequence,payloadHash:'f'.repeat(64),scope}),/CANDIDATE_UNAVAILABLE/);
  ownerProgramId=marketAddress;
  await assert.rejects(repositories.resolve({marketAddress,sequence:candidate.sequence,payloadHash:hash,scope}),/SNAPSHOT_ACCOUNT_UNAVAILABLE/);
  repositories.close();
});

test('program scan repairs omitted historical snapshots by direct PDA read and fails closed if absent',async()=>{
  const programId=String(ANTE_UP_PROGRAM_ADDRESS),marketAddress='11111111111111111111111111111111';
  const zero=new Uint8Array(32);
  const admission={state:AdmissionState.Open,recoveryCount:0,reason:null};
  const marketData=getMarketEncoder().encode({id:zero,admin:address(programId),queryHash:zero,
    queryVersion:1n,phase:MarketPhase.Curve,dataStatus:DataStatus.Valid,admission,
    latestSequence:2n,latestHash:zero,latestDataThrough:1n,latestNowQ12:1n,
    latest7dQ12:1n,validityGeneration:0n});
  const snapshotData=(sequence:bigint)=>getSnapshotEncoder().encode({market:address(marketAddress),sequence,
    payloadHash:zero,evidenceHash:zero,queryHash:zero,queryVersion:1n,configVersion:1n,
    formulaVersion:new Uint8Array(16),dataThrough:1n,publishedAt:2n,activityNowQ12:1n,
    activity7dQ12:1n,dataStatus:DataStatus.Valid,admission});
  const [first]=await findSnapshotPda({market:address(marketAddress),sequence:1n},{programAddress:address(programId)});
  const [second]=await findSnapshotPda({market:address(marketAddress),sequence:2n},{programAddress:address(programId)});
  const account=(data:Uint8Array)=>({owner:programId,data:[Buffer.from(data).toString('base64'),'base64']});
  let present=true,individualReads=0;
  const rpc={
    getProgramAccounts:()=>({send:async()=>({context:{slot:77n},value:[
      {pubkey:marketAddress,account:account(marketData)},
      {pubkey:String(first),account:account(snapshotData(1n))}
    ]})}),
    getAccountInfo:(id:string)=>({send:async()=>{individualReads++;
      return {value:present&&String(id)===String(second)?account(snapshotData(2n)):null};}})
  } as unknown as ConstructorParameters<typeof KitFinalizedAccountReader>[1];
  const reader=new KitFinalizedAccountReader('https://rpc.invalid',rpc);
  const repaired=await reader.scan(programId);
  assert.equal(repaired.accounts.length,3);
  assert.equal(repaired.accounts[2].address,String(second));
  assert.equal(individualReads,1);
  present=false;
  await assert.rejects(reader.scan(programId),/PROGRAM_SCAN_INCOMPLETE/);
});
