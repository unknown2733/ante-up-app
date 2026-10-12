import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash } from '../../data/index.mjs';
import { adaptFrozenSettlement, readFrozenSettlement, type SettlementScope } from '../src/candidate.ts';

const scope:SettlementScope={cluster:'localnet',programId:'FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr',
  marketId:'11111111111111111111111111111111',epoch:'4',epochStartedAt:1_800_000_000,maturityAt:1_800_057_600,
  queryHash:'a'.repeat(64),queryVersion:'1',configVersion:'2',anchor:{graduationPriceAtoms:'1000000',
    graduationNowQ12:'1000000000000',graduation7dQ12:'1000000000000',maxPriceAtoms:'5000000'}};
function row(mode:'NORMAL'|'RECOVERY'|'EMERGENCY'='NORMAL') {
  const outage=mode==='NORMAL'?null:scope.maturityAt-(mode==='RECOVERY'?1_000:100_000);
  const eligible=mode==='EMERGENCY'?outage!+86_400:scope.maturityAt+900;
  const candidate={schemaVersion:'0.1',market:{cluster:scope.cluster,programId:scope.programId,address:scope.marketId},
    epoch:scope.epoch,epochStartedAt:scope.epochStartedAt,maturityAt:scope.maturityAt,mode,eligibleAt:eligible,
    effectiveCloseAt:mode==='EMERGENCY'?Math.min(scope.maturityAt,eligible):scope.maturityAt,
    outageStartedAt:outage,queryHash:scope.queryHash,queryVersion:scope.queryVersion,
    configVersion:scope.configVersion,formulaVersion:'h3-d7-q12-v1',anchor:scope.anchor,
    anchorProvenance:{market:{cluster:scope.cluster,programId:scope.programId,address:scope.marketId},finality:'finalized'},
    source:{kind:mode==='EMERGENCY'?'PUBLISHED_SNAPSHOT':'HISTORICAL_REPLAY',dataThrough:mode==='EMERGENCY'?outage!:scope.maturityAt,
      evidenceHash:'b'.repeat(64),activityNowQ12:'1000000000000',activity7dQ12:'1000000000000',priceAtoms:'1000000',
      ...(mode==='EMERGENCY'?{snapshotRef:{marketId:scope.marketId,sequence:'7',payloadHash:'c'.repeat(64)},snapshotSignature:'sig',snapshotSlot:'123',snapshotPublishedAt:outage!-1}:{})}};
  return {state:'FROZEN_LOCAL',candidate,candidateHash:hash(candidate)};
}

test('C frozen normal, recovery and emergency candidates map to B settlement arguments',()=>{
  for(const mode of ['NORMAL','RECOVERY','EMERGENCY'] as const){
    const mapped=adaptFrozenSettlement(row(mode),scope);
    assert.equal(mapped.mode,mode);
    assert.equal(mapped.settlementPrice,1_000_000n);
    assert.equal(mapped.epoch,4n);
    assert.equal(mapped.outageStartedAt,mode==='NORMAL'?0n:BigInt(scope.maturityAt-(mode==='RECOVERY'?1_000:100_000)));
  }
});

test('candidate adapter rejects changed hash, provenance, epoch, and original outage timeline',()=>{
  const corrupted=row();corrupted.candidate.source.priceAtoms='900000';
  assert.throws(()=>adaptFrozenSettlement(corrupted,scope),/KEEPER_CANDIDATE_INVALID/);
  const wrongEpoch=row();wrongEpoch.candidate.epoch='5';wrongEpoch.candidateHash=hash(wrongEpoch.candidate);
  assert.throws(()=>adaptFrozenSettlement(wrongEpoch,scope),/KEEPER_CANDIDATE_INVALID/);
  const wrongTimeline=row('EMERGENCY');wrongTimeline.candidate.eligibleAt++;
  wrongTimeline.candidateHash=hash(wrongTimeline.candidate);
  assert.throws(()=>adaptFrozenSettlement(wrongTimeline,scope),/KEEPER_CANDIDATE_INVALID/);
  const unverified=row();unverified.candidate.anchorProvenance.finality='confirmed';
  unverified.candidateHash=hash(unverified.candidate);
  assert.throws(()=>adaptFrozenSettlement(unverified,scope),/KEEPER_CANDIDATE_INVALID/);
  const staleRecovery=row('RECOVERY');staleRecovery.candidate.outageStartedAt=scope.maturityAt-100_000;
  staleRecovery.candidateHash=hash(staleRecovery.candidate);
  assert.throws(()=>adaptFrozenSettlement(staleRecovery,scope),/KEEPER_CANDIDATE_INVALID/);
});

test('C settlement journal reader locates only the exact frozen market and epoch',async()=>{
  const work=resolve(import.meta.dirname,'../../../../work/d-keeper-candidates');mkdirSync(work,{recursive:true});
  const path=resolve(work,`${randomUUID()}.json`),frozen=row();
  const key=hash({market:frozen.candidate.market,epoch:frozen.candidate.epoch});
  writeFileSync(path,JSON.stringify({settlements:{[key]:frozen}}));
  assert.equal((await readFrozenSettlement(path,scope))?.settlementPrice,1_000_000n);
  assert.equal(await readFrozenSettlement(path,{...scope,epoch:'5'}),null);
  writeFileSync(path,JSON.stringify({settlements:{wrong:frozen}}));
  await assert.rejects(()=>readFrozenSettlement(path,scope),/KEEPER_CANDIDATE_INVALID/);
});
