import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {FileJobRepository} from './index.mjs';
import {archiveLinkedCompletedJobs,readProofJob} from './archive.mjs';

const recordId='11111111111111111111111111111111';
const id=`proof:${recordId}:original`;

test('linked finalized jobs leave the active journal with a verifiable archive and public link',async t=>{
  const directory=await mkdtemp(join(process.cwd(),'ante-proof-archive-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'jobs.json'),repo=new FileJobRepository(path);
  const job={id,recordId,state:'ISSUED',completion:{state:'FINALIZED'},payloadHash:'a'.repeat(64),
    artifacts:[],confirmations:20};
  await repo.write({[id]:job});
  assert.equal(await archiveLinkedCompletedJobs(path,[]),0);
  assert.deepEqual((await repo.read())[id],job);
  assert.equal(await archiveLinkedCompletedJobs(path,[{finality:'finalized',proofId:id}]),1);
  assert.deepEqual(await repo.read(),{});
  assert.deepEqual(await readProofJob(directory,recordId),job);
  const links=JSON.parse(await readFile(`${path}.index.json`,'utf8'));
  assert.equal(links[id].payloadHash,job.payloadHash);
  assert.equal(await archiveLinkedCompletedJobs(path,[{finality:'finalized',proofId:id}]),0);
  await writeFile(join(directory,'archived-complete',`${recordId}.json`),'{}');
  await assert.rejects(readProofJob(directory,recordId),/ARCHIVE_HASH_MISMATCH/);
});
