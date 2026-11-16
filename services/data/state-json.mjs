// Large immutable histories live in shared, lossless content-addressed blobs.
// Lazy reads keep old replay inputs out of memory during routine polling.
import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
const metadata = new WeakMap();
const marker = '__ante_history_sha256';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const isRef = value => value && Object.keys(value).length === 1 && /^[a-f0-9]{64}$/.test(value[marker]);
const blobPath = (path, hash) => join(dirname(path), '.history', `${hash}.json.gz`);
export function historyArchiveDirectory(path, {stateRoot=process.env.ANTE_UP_HISTORY_STATE_ROOT,
  archiveRoot=process.env.ANTE_UP_HISTORY_ARCHIVE_ROOT}={}) {
  if (!archiveRoot) return null;
  if (!stateRoot) throw Error('HISTORY_ARCHIVE_STATE_ROOT_REQUIRED');
  const rel=relative(resolve(stateRoot),resolve(dirname(path)));
  if (rel==='..' || rel.startsWith(`..${process.platform==='win32'?'\\':'/'}`) || isAbsolute(rel))
    throw Error('HISTORY_STATE_OUTSIDE_ROOT');
  return join(resolve(archiveRoot),rel);
}
export function readHistoryBlob(path, hash, options) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('HISTORY_HASH_INVALID');
  let compressed;
  try {compressed=readFileSync(blobPath(path,hash));}
  catch(error) {
    if(error.code!=='ENOENT')throw error;
    const archive=historyArchiveDirectory(path,options);
    if(!archive)throw error;
    compressed=readFileSync(join(archive,`${hash}.json.gz`));
  }
  const bytes=gunzipSync(compressed);
  if(digest(bytes)!==hash)throw Error('HISTORY_HASH_MISMATCH');
  return bytes;
}
function atomic(path, bytes) {
  mkdirSync(dirname(path), {recursive:true});
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  for(let attempt=0;;attempt++) {
    try {renameSync(tmp, path);break;}
    catch(error){if(!['EPERM','EBUSY'].includes(error.code)||attempt>=9)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);}
  }
}
function hydrate(value, path, options) {
  if (!value || typeof value !== 'object') return value;
  const refs = new Map(); metadata.set(value, refs);
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (isRef(child)) {
      const entry = {ref:child, loaded:false, value:undefined}; refs.set(key, entry);
      Object.defineProperty(value, key, {enumerable:true, configurable:true,
        get() {
          if (!entry.loaded) {
            const bytes = readHistoryBlob(path, child[marker], options);
            entry.value = hydrate(JSON.parse(bytes), path, options); entry.loaded = true;
          }
          return entry.value;
        },
        set(next) { entry.loaded = true; entry.value = next; }
      });
    } else hydrate(child, path, options);
  }
  return value;
}
export function readStateJson(path, options) { return hydrate(JSON.parse(readFileSync(path, 'utf8')), path, options); }
export function writeStateJson(path, value) {
  function pack(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(pack);
    const output = {};
    for (const key of Object.keys(node)) {
      const prior = metadata.get(node)?.get(key);
      if (prior && !prior.loaded) { output[key] = prior.ref; continue; }
      const child = pack(node[key]);
      if ((key === 'observations' || key === 'replayInput') && child && typeof child === 'object') {
        const bytes = Buffer.from(JSON.stringify(child)), hash = digest(bytes), file = blobPath(path, hash);
        // Atomic replacement also repairs a partial/corrupt prior write from this writer.
        let stored=false;
        try {stored=digest(gunzipSync(readFileSync(file)))===hash;}catch{}
        if(!stored)atomic(file, gzipSync(bytes)); output[key] = {[marker]:hash};
      } else output[key] = child;
    }
    return output;
  }
  atomic(path, JSON.stringify(pack(value)));
}
