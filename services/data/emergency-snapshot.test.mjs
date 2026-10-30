import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from './index.mjs';
import {readEmergencySnapshot} from './emergency-snapshot.mjs';

const market={cluster:'devnet',programId:'1'.repeat(32),address:'2'.repeat(32)};
const incident={startedAt:2000};
const row=(sequence,publishedAt,status='VALID')=>{
  const candidate={marketId:market.address,sequence:String(sequence),dataThrough:1800,
    dataStatus:status,activityNowQ12:'100',activity7dQ12:'100'};
  const payloadHash=hash(candidate);
  return {market,candidate,candidateHash:payloadHash,published:{payload:candidate,
    payloadHash,chain:{...market,address:`snapshot-${sequence}`},signature:`signature-${sequence}`,
    slot:String(100+sequence),publishedAt,finality:'finalized'}};
};

test('fallback requires the latest pre-outage valid candidate and finalized chain evidence',async()=>{
  const first=row(1,1900),latest=row(2,1950),after=row(3,2050);
  const repository={read:async()=>({snapshots:{a:first,b:latest,c:after}})};
  let selected=null;
  const readAccount=async(address,sequence,programId)=>{
    assert.equal(address,market.address);assert.equal(programId,market.programId);
    selected=sequence;
    return {address:`snapshot-${sequence}`,data:{market:address,sequence,
      payloadHash:Buffer.from(latest.candidateHash,'hex'),publishedAt:1950n}};
  };
  const readSignatureStatus=async()=>({err:null,confirmationStatus:'finalized',slot:102});
  const result=await readEmergencySnapshot({repository,market,incident,readAccount,readSignatureStatus});
  assert.equal(selected,2n);
  assert.equal(result.payload.sequence,'2');
  await assert.rejects(()=>readEmergencySnapshot({repository,market,incident,
    readAccount:async()=>({address:'snapshot-2',data:{market:market.address,sequence:2n,
      payloadHash:Buffer.alloc(32),publishedAt:1950n}}),readSignatureStatus}),
  /EMERGENCY_SNAPSHOT_REQUIRED/);
  await assert.rejects(()=>readEmergencySnapshot({repository,market,incident,readAccount,
    readSignatureStatus:async()=>({err:null,confirmationStatus:'confirmed',slot:102})}),
  /EMERGENCY_SNAPSHOT_REQUIRED/);
});
