import {readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {FileJobRepository} from './index.mjs';
import {readJson,durableJson} from './worker-support.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const recordIdPattern=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function readProofJob(evidenceDirectory,recordId){
  if(!recordIdPattern.test(recordId))throw Error('INVALID_RECORD_ID');
  const id=`proof:${recordId}:original`;
  const active=await readJson(join(evidenceDirectory,'jobs.json'),{});
  if(active[id])return active[id];
  const archived=await readJson(join(evidenceDirectory,'archived-complete','manifest.json'),{});
  const entry=archived[id];
  if(!entry)return null;
  if(entry.file!==`${recordId}.json`||!(/^[a-f0-9]{64}$/.test(entry.sha256)))throw Error('ARCHIVE_MANIFEST_INVALID');
  const bytes=await readFile(join(evidenceDirectory,'archived-complete',entry.file));
  if(sha256(bytes)!==entry.sha256)throw Error('ARCHIVE_HASH_MISMATCH');
  const job=JSON.parse(bytes.toString('utf8'));
  if(job.id!==id||job.recordId!==recordId)throw Error('ARCHIVE_JOB_MISMATCH');
  return job;
}

// Called by the sole evidence writer while it holds the process-lifetime lock.
// A completed job is archived only after the finalized projection links it.
export async function archiveLinkedCompletedJobs(jobsPath,records){
  const repo=new FileJobRepository(jobsPath),jobs=await repo.read();
  const linked=new Set(records.filter(r=>r.finality==='finalized').map(r=>r.proofId).filter(Boolean));
  const eligible=Object.entries(jobs).filter(([id,job])=>linked.has(id)&&
    job.state==='ISSUED'&&job.completion?.state==='FINALIZED');
  if(!eligible.length)return 0;
  const evidenceDirectory=dirname(jobsPath),archiveDirectory=join(evidenceDirectory,'archived-complete');
  const manifestPath=join(archiveDirectory,'manifest.json'),archiveIndexPath=`${jobsPath}.archive-index.json`;
  const manifest=await readJson(manifestPath,{}),archivedLinks=await readJson(archiveIndexPath,{});
  const links=await readJson(`${jobsPath}.index.json`,{});
  await mkdir(archiveDirectory,{recursive:true,mode:0o700});
  for(const [id,job] of eligible){
    if(!recordIdPattern.test(job.recordId)||id!==`proof:${job.recordId}:original`||!links[id])
      throw Error('ARCHIVE_SCOPE_INVALID');
    const file=`${job.recordId}.json`,path=join(archiveDirectory,file);
    if(manifest[id]){
      const bytes=await readFile(path);
      if(manifest[id].file!==file||sha256(bytes)!==manifest[id].sha256||
        bytes.toString('utf8')!==JSON.stringify(job))throw Error('ARCHIVE_CONFLICT');
    }else{
      await durableJson(path,job);
      const bytes=await readFile(path);
      manifest[id]={file,sha256:sha256(bytes),bytes:bytes.length};
    }
    if(archivedLinks[id]&&JSON.stringify(archivedLinks[id])!==JSON.stringify(links[id]))
      throw Error('ARCHIVE_LINK_CONFLICT');
    archivedLinks[id]=links[id];
  }
  await durableJson(manifestPath,manifest);
  await durableJson(archiveIndexPath,archivedLinks);
  for(const [id] of eligible)delete jobs[id];
  await repo.write(jobs);
  return eligible.length;
}
