import test from 'node:test';
import assert from 'node:assert/strict';
import {auditFinance,syntheticCandidate,safeError,runProfile,DEMO_LABEL} from '../../scripts/qa-finance-devnet.mjs';
import {UNIT,pro,indexPrice} from '../../contracts/reference.mjs';
import {verifyPublishedSnapshot} from '../../services/indexer/src/snapshot.ts';

test('synthetic snapshot is canonical and compatible with the production finalized resolver',()=>{
  const item=syntheticCandidate({market:'test-market',sequence:1n,queryHash:new Uint8Array(32).fill(1),
    configVersion:1n,computedAt:1800000000,activity:125n});
  const c=item.candidate;
  const verified=verifyPublishedSnapshot({cluster:'devnet',programId:'test-program',signature:'test-signature',slot:'1',
    marketAddress:c.marketId,marketId:c.marketId,sequence:c.sequence,eventPayloadHash:item.candidateHash,candidate:c,
    account:{...c,address:'test-snapshot',ownerProgramId:'test-program',marketAddress:c.marketId,
      payloadHash:item.candidateHash,publishedAt:1800000001}});
  assert.equal(verified.payloadHash,item.candidateHash);
  assert.equal(item.syntheticEvidence.notRealTrend,true);
  assert.match(item.syntheticEvidence.description,/not measured X activity/);
});

test('provider errors never expose RPC credential URLs',()=>{
  const safe=safeError(new Error('failed https://example.com/?api-key=secret-token request'));
  assert.ok(!safe.includes('secret-token'));assert.match(safe,/REDACTED/);
});

test('QA audit counts all promised capital and preserves locked LP shares',()=>{
  const finance={externalQ:1000n*UNIT,pmax:4800000n,proReserved:2200n*UNIT,
    otherReserved:5n*UNIT,totalShares:7100n*UNIT,lockedShares:7100n*UNIT};
  const ok=auditFinance({finance,assets:8505n*UNIT,price:1200000n});
  assert.equal(ok.free,1000n*UNIT);
  assert.equal(ok.spotLiability,1200n*UNIT);
  assert.throws(()=>auditFinance({finance,assets:7505n*UNIT-1n,price:1200000n}),/capital invariant/);
  assert.throws(()=>auditFinance({finance:{...finance,totalShares:finance.lockedShares-1n},assets:8505n*UNIT,price:1200000n}),/locked shares/);
});

test('synthetic rise and fall exercise both 5x payoff directions independently of real data',()=>{
  const anchor={pg:1200000n,sg:125n,dg:100n};
  const base=indexPrice(anchor.pg,anchor.sg,anchor.dg,125n,100n);
  const up=indexPrice(anchor.pg,anchor.sg,anchor.dg,150n,100n);
  const down=indexPrice(anchor.pg,anchor.sg,anchor.dg,100n,100n);
  assert.equal(base.price,1200000n);assert.equal(up.price,1440000n);assert.equal(down.price,960000n);
  assert.equal(pro(100n*UNIT,50000n,base.price,up.price,base.maximum,'long').payout,200n*UNIT);
  assert.equal(pro(100n*UNIT,50000n,base.price,up.price,base.maximum,'short').payout,0n);
  assert.equal(pro(100n*UNIT,50000n,up.price,down.price,base.maximum,'long').payout,0n);
  assert.equal(pro(100n*UNIT,50000n,up.price,down.price,base.maximum,'short').payout,266666666n);
});

test('demo profile has distinct identity, bounded support and honest candidate provenance',()=>{
  const profile=runProfile({ANTE_UP_QA_PROFILE:'demo'});
  assert.equal(profile.label,DEMO_LABEL);assert.equal(profile.maxContribution,7200n*UNIT);
  assert.notEqual(profile.label,runProfile({}).label);
  assert.throws(()=>runProfile({ANTE_UP_QA_PROFILE:'arbitrary'}));
  const item=syntheticCandidate({market:'test-market',sequence:1n,queryHash:new Uint8Array(32),
    configVersion:1n,computedAt:1800000000,activity:125n,label:profile.label});
  assert.equal(item.syntheticEvidence.label,DEMO_LABEL);assert.equal(item.syntheticEvidence.notRealTrend,true);
});
