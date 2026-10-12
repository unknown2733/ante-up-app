import test from 'node:test';
import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import { AdmissionReason, AdmissionState, DataStatus, findSnapshotPda, getSnapshotEncoder, ANTE_UP_PROGRAM_ADDRESS } from '../../../clients/chain/dist/index.js';
import { fixtureMarkets } from '../../api/src/fixture.ts';
import { SqliteEventRepositories } from '../src/repositories.ts';
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
