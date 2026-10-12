import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FileJobRepository, enqueue, processJob, payloadHash, getProofStatus, fetchManifest, status } from './index.mjs';

const record = { id:'r1', finality:'finalized', status:'CLOSED_NA', result:{kind:'na',reason:'DATA_STALE'}, exit:{executedAt:123} };
const versions = { schemaVersion:'0.1',formulaVersion:'h3-d7-q12-v1',configVersion:'1',queryVersion:'1' };
const input = { record, versions, artifacts:[{key:'market',kind:'market',content:'common counts'}, {key:'record',kind:'record',content:'record facts'}] };
const withRepo = async fn => {
  const dir = await mkdtemp(join(process.cwd(),'ante-proof-'));
  try { await fn(new FileJobRepository(join(dir,'jobs.json'))); }
  finally { await rm(dir,{recursive:true,force:true}); }
};
function fakeAdapter() {
  const data = new Map(), issues = new Map(); let uploads = 0, issueCalls = 0, confirmations = 19, manifestConfirmations = null, failVerify = false;
  return {
    data, issues,
    get uploads() { return uploads; }, get issueCalls() { return issueCalls; },
    set confirmations(value) { confirmations = value; }, set manifestConfirmations(value) { manifestConfirmations = value; }, set failVerify(value) { failVerify = value; },
    async upload(key, content, contentHash) {
      uploads++; const ref = {contentHash,arweaveItemId:`item:${key}`,parentTransactionId:`parent:${key}`};
      data.set(ref.arweaveItemId,{content,ref}); return ref;
    },
    async verify(ref) {
      if (failVerify) throw new Error('NETWORK');
      const stored = data.get(ref.arweaveItemId);
      return {receiptValid:true,itemId:ref.arweaveItemId,parentTransactionId:ref.parentTransactionId,
        itemIncluded:true,content:stored.content,confirmations:ref.arweaveItemId.startsWith('item:manifest:') && manifestConfirmations !== null ? manifestConfirmations : confirmations};
    },
    async fetch(ref) { return data.get(ref.arweaveItemId).content; },
    async lookupIssue(key) { return issues.get(key) ?? null; },
    async issue(key,hash,manifestRef) {
      issueCalls++; assert.equal(hash,manifestRef.contentHash);
      issues.set(key,{sasId:`sas:${hash}`,finalized:true});
      return {pending:true}; // response lost after actual issue
    }
  };
}

test('canonical payload hash ignores object insertion order', () => {
  assert.equal(payloadHash({z:'2',a:1}),payloadHash({a:1,z:'2'}));
});

test('manifest and all items reach 20 confirmations before a single finalized SAS, surviving restart', async () => withRepo(async repo => {
  const adapter = fakeAdapter(); const job = await enqueue(repo,input);
  assert.equal(status(job).payloadHash,null);
  assert.equal(status(job).manifestRef,null);
  assert.equal((await enqueue(repo,input)).id,job.id);
  let s = await processJob(repo,job.id,adapter,1000);
  assert.equal(s.state,'CONFIRMING'); assert.equal(s.confirmations,19);
  assert.equal(adapter.uploads,3); assert.equal(adapter.issueCalls,0);
  assert.equal(s.manifestRef.contentHash,s.payloadHash);
  const recovered = await fetchManifest(adapter,s);
  assert.equal(payloadHash(recovered),s.payloadHash);
  assert.equal(recovered.evidence.length,2);
  adapter.confirmations = 20;
  s = await processJob(new FileJobRepository(repo.path),job.id,adapter,1300);
  assert.equal(s.state,'READY_TO_ISSUE'); assert.equal(adapter.issueCalls,1);
  s = await processJob(new FileJobRepository(repo.path),job.id,adapter,1600);
  assert.equal(s.state,'ISSUED'); assert.equal(adapter.issueCalls,1);
  assert.equal((await getProofStatus(repo,job.id)).manifestRef.contentHash,s.payloadHash);
  assert.equal((await processJob(repo,job.id,adapter,1900)).state,'ISSUED');
  assert.equal(adapter.issueCalls,1);
}));

test('uncertain SAS submission survives restart without an automatic second issue',async()=>withRepo(async repo=>{
  const adapter=fakeAdapter(),job=await enqueue(repo,input);adapter.confirmations=20;
  adapter.issue=async()=>{adapter.issues.delete(job.id);return {pending:true};};
  let calls=0;const issue=adapter.issue;adapter.issue=async(...args)=>{calls++;return issue(...args);};
  assert.equal((await processJob(repo,job.id,adapter,1000)).state,'READY_TO_ISSUE');
  assert.equal((await processJob(new FileJobRepository(repo.path),job.id,adapter,1300)).state,'READY_TO_ISSUE');
  assert.equal(calls,1);
}));

test('failed verification has 5/15/60-minute retry, distinct from ordinary confirmation wait', async () => withRepo(async repo => {
  const adapter = fakeAdapter(), job = await enqueue(repo,input);
  adapter.failVerify = true;
  let s = await processJob(repo,job.id,adapter,1000);
  assert.equal(s.retryAt,1300); assert.equal(s.error,'NETWORK');
  s = await processJob(repo,job.id,adapter,1300);
  assert.equal(s.retryAt,2200);
  s = await processJob(repo,job.id,adapter,2200);
  assert.equal(s.retryAt,5800);
  adapter.failVerify = false;
  s = await processJob(repo,job.id,adapter,5800);
  assert.equal(s.state,'CONFIRMING'); assert.equal(s.retryAt,6100); assert.equal(s.error,null);
}));

test('a manifest at 19 confirmations blocks issue even when every artifact has 20', async () => withRepo(async repo => {
  const adapter = fakeAdapter(), job = await enqueue(repo,input);
  adapter.confirmations = 20; adapter.manifestConfirmations = 19;
  const s = await processJob(repo,job.id,adapter,1000);
  assert.equal(s.state,'CONFIRMING'); assert.equal(s.confirmations,19); assert.equal(adapter.issueCalls,0);
}));

test('tampered content or incomplete status cannot claim issue readiness', async () => withRepo(async repo => {
  const adapter = fakeAdapter(), job = await enqueue(repo,input);
  adapter.confirmations = 20;
  const originalVerify = adapter.verify;
  adapter.verify = async ref => ({...(await originalVerify(ref)),content:'tampered'});
  const s = await processJob(repo,job.id,adapter,1000);
  assert.equal(s.state,'UPLOADED'); assert.equal(s.error,'CONTENT_MISMATCH'); assert.equal(adapter.issueCalls,0);
  assert.throws(() => status({...job,state:'READY_TO_ISSUE'}));
}));

test('accepted upload receipt persists while parent inclusion is still unresolved',async()=>withRepo(async repo=>{
  const job=await enqueue(repo,input), data=new Map(); let resolvable=false, uploads=0;
  const adapter={
    async upload(key,content,contentHash){uploads++;const id=`item:${key}`;data.set(id,content);
      return {ref:{contentHash,arweaveItemId:id,parentTransactionId:null},receipt:{id,version:'fixture'}};},
    async resolve(ref,receipt){assert.equal(receipt.id,ref.arweaveItemId);
      return resolvable?{...ref,parentTransactionId:`parent:${ref.arweaveItemId}`}:null;},
    async verify(ref,receipt){assert.equal(receipt.id,ref.arweaveItemId);
      return {receiptValid:true,itemId:ref.arweaveItemId,parentTransactionId:ref.parentTransactionId,
        itemIncluded:true,content:data.get(ref.arweaveItemId),confirmations:19};},
    async lookupIssue(){return null;},async issue(){throw new Error('must not issue');}
  };
  let s=await processJob(repo,job.id,adapter,1000);
  assert.equal(s.state,'QUEUED');assert.equal(s.payloadHash,null);assert.equal(uploads,2);
  const saved=(await repo.read())[job.id]; assert.equal(saved.artifacts[0].receipt.id,'item:market');
  resolvable=true;
  s=await processJob(new FileJobRepository(repo.path),job.id,adapter,1300);
  assert.equal(s.state,'CONFIRMING');assert.equal(uploads,3);assert.equal(s.confirmations,19);
}));
