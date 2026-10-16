import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import {replaceJournal} from '../../scripts/atomic-rename.mjs';
import { dirname } from 'node:path';

export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('INVALID_INPUT');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const payloadHash = payload => sha256(Buffer.from(canonical(payload), 'utf8'));
const check = (ok, error = 'INVALID_INPUT') => { if (!ok) throw new Error(error); };
const validItem = (ref, expectedHash) => ref && ref.contentHash === expectedHash &&
  typeof ref.arweaveItemId === 'string' && ref.arweaveItemId.length > 0;
const validRef = (ref, expectedHash) => validItem(ref, expectedHash) &&
  typeof ref.parentTransactionId === 'string' && ref.parentTransactionId.length > 0;
const failureDelay = attempts => [300, 900, 3600][Math.min(attempts - 1, 2)];

// One-writer journal. The supervised service holds a process-lifetime flock.
export class FileJobRepository {
  constructor(path) { this.path = path; }
  async read() { try { return JSON.parse(await readFile(this.path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
  async write(jobs) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const file=await open(temporary,'w',0o600);
    try{await file.writeFile(canonical(jobs),'utf8');await file.sync();}finally{await file.close();}
    await replaceJournal(temporary, this.path);
    if(process.platform!=='win32'){const directory=await open(dirname(this.path),'r');try{await directory.sync();}finally{await directory.close();}}
  }
}

export function createJob({ record, versions, artifacts, replacesProofId = null }) {
  check(record?.finality === 'finalized' && (record.status === 'CLOSED_RESULT' || record.status === 'CLOSED_NA') && record.exit);
  check(versions?.schemaVersion === '0.1' && versions.formulaVersion === 'h3-d7-q12-v1' && Array.isArray(artifacts) && artifacts.length > 0);
  check(artifacts.every(a => typeof a.key === 'string' && a.key.length > 0 && typeof a.content === 'string' && (a.kind === 'market' || a.kind === 'record')));
  check(new Set(artifacts.map(a => a.key)).size === artifacts.length);
  const id = `proof:${record.id}:${replacesProofId ?? 'original'}`;
  return { id, recordId: record.id, record, versions, replacesProofId, artifacts: artifacts.map(a => {
    const contentHash = sha256(Buffer.from(a.content, 'utf8'));
    if (a.ref) check(validItem(a.ref, contentHash));
    return { key:a.key, kind:a.kind, content:a.content, contentHash, ref:a.ref ?? null, receipt:a.receipt ?? null };
  }), payload:null, payloadHash:null, manifestRef:null, manifestReceipt:null, state:'QUEUED', confirmations:null,
    sasId:null, retryAt:null, error:null, replacementId:null, failedAttempts:0 };
}

export async function enqueue(repo, input) {
  const job = createJob(input), jobs = await repo.read();
  if (jobs[job.id]) {
    const shape = j => ({ record:j.record, versions:j.versions, replacesProofId:j.replacesProofId,
      artifacts:j.artifacts.map(({key,kind,content,contentHash}) => ({key,kind,content,contentHash})) });
    check(canonical(shape(jobs[job.id])) === canonical(shape(job)), 'VERSION_MISMATCH');
    return jobs[job.id];
  }
  jobs[job.id] = job; await repo.write(jobs); return job;
}

export function status(job) {
  const refs = job.artifacts.map(a => a.ref).filter(Boolean);
  if (job.state === 'QUEUED') check(job.payloadHash === null && job.manifestRef === null);
  if (job.state === 'UPLOADED') check(typeof job.payloadHash === 'string' && refs.length === job.artifacts.length && refs.every((r,i) => validRef(r,job.artifacts[i].contentHash)), 'VERSION_MISMATCH');
  if (['CONFIRMING','READY_TO_ISSUE','ISSUED'].includes(job.state)) {
    check(typeof job.payloadHash === 'string' && validRef(job.manifestRef, job.payloadHash) && refs.length === job.artifacts.length, 'VERSION_MISMATCH');
  }
  if (['READY_TO_ISSUE','ISSUED'].includes(job.state)) check(job.confirmations >= 20, 'VERSION_MISMATCH');
  if (job.state === 'ISSUED') check(typeof job.sasId === 'string' && job.sasId.length > 0 && job.confirmations >= 20, 'VERSION_MISMATCH');
  if (['INVALID','REPLACED'].includes(job.state) && job.manifestRef) check(validRef(job.manifestRef,job.payloadHash), 'VERSION_MISMATCH');
  return { id:job.id, recordId:job.recordId, payloadHash:job.payloadHash, manifestRef:job.manifestRef,
    state:job.state, evidence:refs, confirmations:job.confirmations, sasId:job.sasId,
    retryAt:job.retryAt, error:job.error, replacementId:job.replacementId };
}

export async function getProofStatus(repo, id) {
  const jobs = await repo.read();
  return jobs[id] ? status(jobs[id]) : null;
}

export async function fetchManifest(adapter, proofStatus) {
  check(proofStatus?.payloadHash && validRef(proofStatus.manifestRef, proofStatus.payloadHash), 'DATA_NOT_READY');
  const bytes = await adapter.fetch(proofStatus.manifestRef);
  check(typeof bytes === 'string' && sha256(Buffer.from(bytes, 'utf8')) === proofStatus.payloadHash, 'VERSION_MISMATCH');
  return JSON.parse(bytes);
}

async function verifyOne(adapter, ref, receipt) {
  const proof = await adapter.verify(ref, receipt);
  check(proof?.receiptValid === true && proof.itemId === ref.arweaveItemId &&
    proof.parentTransactionId === ref.parentTransactionId, 'INVALID_RECEIPT');
  check(typeof proof.content === 'string' && sha256(Buffer.from(proof.content, 'utf8')) === ref.contentHash, 'CONTENT_MISMATCH');
  check(Number.isSafeInteger(proof.confirmations) && proof.confirmations >= 0, 'INVALID_CONFIRMATIONS');
  return proof.itemIncluded === true ? proof.confirmations : 0;
}

export async function processJob(repo, id, adapter, now) {
  check(Number.isSafeInteger(now) && now >= 0);
  const jobs = await repo.read(), job = jobs[id]; check(job);
  if (['ISSUED','INVALID','REPLACED'].includes(job.state) || (job.retryAt !== null && now < job.retryAt)) return status(job);
  const save = async () => { jobs[id] = job; await repo.write(jobs); };
  try {
    for (const artifact of job.artifacts) {
      if (artifact.ref) continue;
      const uploaded = await adapter.upload(artifact.key, artifact.content, artifact.contentHash);
      const ref = uploaded?.ref ?? uploaded;
      check(validItem(ref, artifact.contentHash), 'INVALID_RECEIPT');
      artifact.ref = ref; artifact.receipt = uploaded?.receipt ?? null; await save();
    }
    for (const artifact of job.artifacts) {
      if (validRef(artifact.ref, artifact.contentHash)) continue;
      check(typeof adapter.resolve === 'function', 'PENDING_CONFIRMATION');
      const resolved = await adapter.resolve(artifact.ref, artifact.receipt);
      if (resolved && validRef(resolved, artifact.contentHash) && resolved.arweaveItemId === artifact.ref.arweaveItemId) {
        artifact.ref = resolved; await save();
      } else {
        job.retryAt = now + 300; job.error = null; await save(); return status(job);
      }
    }
    if (!job.payload) {
      job.payload = { schemaVersion:'0.1', record:job.record, versions:job.versions,
        evidence:job.artifacts.map(a => a.ref), replacesProofId:job.replacesProofId };
      job.payloadHash = payloadHash(job.payload);
      job.state = 'UPLOADED'; await save();
    }
    const manifestBytes = canonical(job.payload);
    check(sha256(Buffer.from(manifestBytes,'utf8')) === job.payloadHash, 'VERSION_MISMATCH');
    if (!job.manifestRef) {
      const uploaded = await adapter.upload(`manifest:${job.id}`, manifestBytes, job.payloadHash);
      const ref = uploaded?.ref ?? uploaded;
      check(validItem(ref, job.payloadHash), 'INVALID_RECEIPT');
      job.manifestRef = ref; job.manifestReceipt = uploaded?.receipt ?? null; await save();
    }
    if (!validRef(job.manifestRef, job.payloadHash)) {
      check(typeof adapter.resolve === 'function', 'PENDING_CONFIRMATION');
      const resolved = await adapter.resolve(job.manifestRef, job.manifestReceipt);
      if (resolved && validRef(resolved,job.payloadHash) && resolved.arweaveItemId === job.manifestRef.arweaveItemId) {
        job.manifestRef = resolved; await save();
      } else { job.retryAt = now + 300; job.error = null; await save(); return status(job); }
    }
    // Each check reads the item and its parent status. Unbounded fan-out can
    // exhaust gateway connections and turn a complete upload into timeouts.
    const refs = [...job.artifacts.map(a => [a.ref,a.receipt]), [job.manifestRef,job.manifestReceipt]];
    const confirmations = [];
    for (let offset = 0; offset < refs.length; offset += 4) {
      confirmations.push(...await Promise.all(refs.slice(offset, offset + 4)
        .map(([ref,receipt]) => verifyOne(adapter,ref,receipt))));
    }
    job.confirmations = Math.min(...confirmations);
    job.error = null;
    if (job.confirmations < 20) {
      job.state = 'CONFIRMING'; job.retryAt = now + 300; job.failedAttempts = 0; await save(); return status(job);
    }
    job.state = 'READY_TO_ISSUE'; job.retryAt = null; await save();
    // The adapter must reconcile uncertain chain outcomes by this stable key.
    const existing = await adapter.lookupIssue(job.id,job.payloadHash,job.manifestRef,job.payload);
    if (existing?.finalized && existing.sasId) {
      job.sasId = existing.sasId; job.state = 'ISSUED'; job.retryAt = null; job.failedAttempts = 0; await save(); return status(job);
    }
    if (existing?.pending) { job.retryAt = now + 300; await save(); return status(job); }
    // A prior request may have reached the chain even if its response was
    // lost. The deterministic PDA is reconciled above; never submit again
    // automatically while the outcome is unknown.
    if (job.sasSubmission) { job.retryAt = now + 300; await save(); return status(job); }
    job.sasSubmission = {state:'REQUESTING',requestedAt:now}; await save();
    const result = await adapter.issue(job.id, job.payloadHash, job.manifestRef, job.payload);
    job.sasSubmission = {state:'SUBMITTED',requestedAt:now,signature:result?.signature??null};
    if (result?.finalized && result.sasId) { job.sasId = result.sasId; job.state = 'ISSUED'; job.retryAt = null; job.failedAttempts = 0; await save(); }
    else { job.retryAt = now + 300; await save(); }
    return status(job);
  } catch (e) {
    job.failedAttempts += 1;
    job.error = String(e.message ?? e);
    job.retryAt = now + failureDelay(job.failedAttempts);
    await save(); return status(job);
  }
}
