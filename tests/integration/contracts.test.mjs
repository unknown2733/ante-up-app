import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createApp, FixtureReadAdapter} from '../../services/api/src/app.ts';
import {EventIndex} from '../../services/indexer/src/index.ts';
import {createHttpApi} from '../../apps/web/src/http.ts';
import {replay, HISTORY_MINUTES, hash} from '../../services/data/index.mjs';
import {FileJobRepository,enqueue,processJob,fetchManifest,getProofStatus} from '../../services/evidence/index.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {formulaVersionBytes,decodeHash,parseU64,admissionBorshBytes} from '../../clients/chain/encoding.mjs';
import {getPublishSnapshotInstructionAsync, parsePublishSnapshotInstruction, findMarketPda, DataStatus, AdmissionState, ANTE_UP_PROGRAM_ADDRESS} from '../../clients/chain/dist/index.js';

// These are real loopback HTTP requests. Chain finality is explicitly a fixture.
async function http(app, fn) {
  const server=createServer(async(req,res)=>{
    try {
      const reply=await app.handle(new Request(`http://127.0.0.1${req.url}`));
      res.writeHead(reply.status,Object.fromEntries(reply.headers));
      res.end(Buffer.from(await reply.arrayBuffer()));
    } catch(e) {res.writeHead(500);res.end(String(e));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  try {return await fn(`http://127.0.0.1:${server.address().port}`)}
  finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}

test('D current-state projection -> actual HTTP -> F profile and leaderboard',async()=>{
  const now=1800000000, fixture=new FixtureReadAdapter(()=>now);
  const closed=(await fixture.records()).find(r=>r.status==='CLOSED_RESULT');
  const opened={...closed,exit:null,result:null,status:'OPEN',proofId:null};
  const index=new EventIndex();
  const event=(record,slot)=>({cluster:'localnet',programId:'fixture:program',signature:`fixture:sig${slot}`,eventIndex:0,slot:String(slot),finality:'finalized',kind:'freeRecord',record});
  index.ingest(event(closed,2));index.ingest(event(opened,1));index.ingest(event(closed,2));
  const read={markets:()=>fixture.markets(),records:async()=>index.finalizedRecords(),proofs:()=>fixture.proofs(),heldCalculationWallets:async()=>new Set()};
  await http(createApp({now:()=>now,read}),async origin=>{
    await assert.rejects(createHttpApi(origin,{allowFixture:false}).listMarkets(),/fixture/);
    const api=createHttpApi(origin,{allowFixture:true});
    const profile=await api.getProfile(closed.wallet);
    assert.equal(profile.mode,'fixture');assert.equal(profile.data.openRecords.length,0);
    assert.equal(profile.data.closedRecords.length,1);assert.equal(profile.data.closedValidCount,'1');
    const board=await api.getLeaderboard('7d');
    assert.equal(board.data.period,'7d');assert.equal(board.data.rows.length,1);
    assert.equal(board.data.rows[0].status,'ELIGIBLE');assert.equal(board.data.rows[0].closedValidCount,'1');
    assert.equal((await api.getProof('missing:proof/id')).data,null);
    assert.equal((await api.openFree(closed.wallet,closed.marketId)).kind,'notExecutable');
  });
});

test('C replay candidate with real hash survives D validation and F HTTP transport',async()=>{
  const start=1700000040,end=start+HISTORY_MINUTES*60;
  const fixture=new FixtureReadAdapter(()=>end), market=(await fixture.markets())[0];
  const base={marketId:market.id,queryVersion:'1',queryHash:'a'.repeat(64)};
  const observations=Array.from({length:HISTORY_MINUTES},(_,i)=>({...base,
    bucketStart:start+i*60,bucketEnd:start+(i+1)*60,value:{kind:'count',count:'1'},
    receivedAt:start+(i+1)*60,validatedAt:start+(i+1)*60,revision:'0',rawHash:'b'.repeat(64)}));
  const output=replay({...base,observations,start,end,computedAt:end,sequence:'7'});
  assert.equal(output.candidate.formulaVersion,'h3-d7-q12-v1');
  assert.equal(hash(output.candidate),output.candidateHash);
  assert.equal(formulaVersionBytes(output.candidate.formulaVersion).length,16);
  assert.equal(decodeHash(output.candidate.queryHash).length,32);
  assert.equal(parseU64(output.candidate.activityNowQ12),1440000000000000n);
  assert.deepEqual([...admissionBorshBytes(output.candidate.admission)],[2,2,0]);
  // Exercise the actual compiled-IDL/Codama wire boundary, without submitting.
  const [marketAddress] = await findMarketPda({marketId: decodeHash(base.queryHash)});
  const c = output.candidate;
  const instruction = await getPublishSnapshotInstructionAsync({market: marketAddress,
    publisher: {address: ANTE_UP_PROGRAM_ADDRESS, signTransactions: async transactions => transactions},
    sequence: parseU64(c.sequence), queryHash: decodeHash(c.queryHash), queryVersion: parseU64(c.queryVersion),
    configVersion: parseU64(c.configVersion), formulaVersion: formulaVersionBytes(c.formulaVersion),
    dataThrough: BigInt(c.dataThrough), activityNowQ12: parseU64(c.activityNowQ12), activity7dQ12: parseU64(c.activity7dQ12),
    dataStatus: DataStatus.Valid, admission: {state: AdmissionState.Open, recoveryCount: c.admission.recoveryCount, reason: null},
    evidenceHash: decodeHash(c.evidenceHash), payloadHash: decodeHash(output.candidateHash)});
  const encoded = parsePublishSnapshotInstruction(instruction);
  assert.equal(encoded.accounts.market.address, marketAddress);
  assert.equal(encoded.data.sequence.toString(), c.sequence);
  assert.equal(encoded.data.activityNowQ12.value.toString(), c.activityNowQ12);
  assert.equal(Buffer.from(encoded.data.payloadHash).toString('hex'), output.candidateHash);
  market.snapshot={...market.snapshot,payload:output.candidate,payloadHash:output.candidateHash};
  market.dataStatus=output.candidate.dataStatus;
  const read={markets:async()=>[market],records:()=>fixture.records(),proofs:()=>fixture.proofs(),heldCalculationWallets:async()=>new Set()};
  await http(createApp({now:()=>end,read}),async origin=>{
    const result=await createHttpApi(origin,{allowFixture:true}).getMarket(market.id);
    assert.deepEqual(result.data.snapshot.payload,output.candidate);
    assert.equal(result.data.snapshot.payloadHash,output.candidateHash);
    assert.equal(result.data.snapshot.payload.queryHash,base.queryHash);
  });
});

test('E persisted proof -> D validator/API -> F reader -> archived exact manifest',async()=>{
  const dir=await mkdtemp(join(process.cwd(),'.proof-integration-'));
  try {
    const now=1800000000,fixture=new FixtureReadAdapter(()=>now);
    const record=(await fixture.records()).find(r=>r.status==='CLOSED_RESULT');
    record.proofId=null;
    const repo=new FileJobRepository(join(dir,'jobs.json'));
    const versions={schemaVersion:'0.1',formulaVersion:'h3-d7-q12-v1',configVersion:'1',queryVersion:'1'};
    const job=await enqueue(repo,{record,versions,artifacts:[{key:'market',kind:'market',content:'fixture counts and calculation basis'}]});
    const blobs=new Map();let confirmations=19,issued=0;
    const adapter={
      async upload(key,content,contentHash){blobs.set(contentHash,content);return {contentHash,arweaveItemId:`fixture:item:${contentHash}`,parentTransactionId:`fixture:parent:${contentHash}`}},
      async verify(ref){return {receiptValid:true,itemId:ref.arweaveItemId,parentTransactionId:ref.parentTransactionId,itemIncluded:true,content:blobs.get(ref.contentHash),confirmations}},
      async fetch(ref){return blobs.get(ref.contentHash)},
      async lookupIssue(){return null},
      async issue(){issued++;return {sasId:'fixture:sas',finalized:true}}
    };
    const confirming = await processJob(repo,job.id,adapter,now);
    assert.equal(confirming.state,'CONFIRMING',JSON.stringify(confirming));
    assert.equal(issued,0);assert.equal(blobs.size,2,'artifact and final manifest must both be archived');
    confirmations=20;
    const restarted=new FileJobRepository(join(dir,'jobs.json'));
    assert.equal((await processJob(restarted,job.id,adapter,now+300)).state,'ISSUED');
    assert.equal((await processJob(restarted,job.id,adapter,now+600)).state,'ISSUED');
    assert.equal(issued,1);
    const read={markets:()=>fixture.markets(),records:async()=>[{...record,proofId:job.id}],
      proofs:async()=>[await getProofStatus(restarted,job.id)],heldCalculationWallets:async()=>new Set()};
    await http(createApp({now:()=>now+600,read}),async origin=>{
      const api=createHttpApi(origin,{allowFixture:true});
      const result=(await api.getRecord(record.id)).data;
      const proof=(await api.getProof(result.proofId)).data;
      assert.equal(proof.state,'ISSUED');assert.equal(proof.payloadHash,proof.manifestRef.contentHash);
      const manifest=await fetchManifest(adapter,proof);
      assert.deepEqual(manifest.record.result,record.result);
      assert.equal(manifest.versions.formulaVersion,versions.formulaVersion);
      assert.equal(hash(manifest),proof.payloadHash);
    });
  }finally{await rm(dir,{recursive:true,force:true})}
});
