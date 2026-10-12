import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { FinalizedPoller, type ProgramEventDecoder } from './poller.ts';
import { KitFinalizedRpc } from './rpc.ts';
import { SqliteProjectionStore, type StreamKey } from './sqlite.ts';
import { GeneratedProgramEventDecoder } from './generated-decoder.ts';
import { heartbeat } from '../../../scripts/runtime-status.mjs';
import { KitFinalizedAccountReader, SqliteEventRepositories } from './repositories.ts';

const cluster = process.env.ANTE_UP_CLUSTER;
const programId = process.env.ANTE_UP_PROGRAM_ID;
const rpcUrl = process.env.ANTE_UP_RPC_URL;
const dbPath = process.env.ANTE_UP_INDEX_DB;
const decoderPath = process.env.ANTE_UP_DECODER_MODULE;
if ((cluster !== 'localnet' && cluster !== 'devnet') || !programId || !rpcUrl || !dbPath) {
  throw new Error('Set ANTE_UP_CLUSTER, ANTE_UP_PROGRAM_ID, ANTE_UP_RPC_URL, and ANTE_UP_INDEX_DB before RPC polling');
}
const store = new SqliteProjectionStore(resolve(dbPath));
const repositories = new SqliteEventRepositories(resolve(dbPath),new KitFinalizedAccountReader(rpcUrl));
try {
  const scope: StreamKey = {cluster,programId,address:programId};
  const candidatesPath = process.env.ANTE_UP_CANDIDATES_PATH ? resolve(process.env.ANTE_UP_CANDIDATES_PATH) : null;
  // Independently written candidate journals share one validated projection writer.
  const extraPaths: unknown = JSON.parse(process.env.ANTE_UP_EXTRA_CANDIDATES_PATHS ?? '[]');
  if (!Array.isArray(extraPaths) || extraPaths.length > 8 || extraPaths.some(p => typeof p !== 'string' || !p.trim())) {
    throw new Error('INVALID_EXTRA_CANDIDATES_PATHS');
  }
  const candidatePaths = [...new Set([...(candidatesPath ? [candidatesPath] : []), ...extraPaths.map(p => resolve(p as string))])];
  const proofsPath = process.env.ANTE_UP_PROOFS_PATH ? resolve(process.env.ANTE_UP_PROOFS_PATH) : null;
  const importedFiles=new Map<string,string>();
  const refresh = async (key: StreamKey) => {
    for (const [path, importFile] of [
      ...candidatePaths.map(path => [path, (file: string) => repositories.importCandidateFile(file,key)] as const),
      [proofsPath, (file: string) => repositories.importProofFile(file,key)],
    ] as const) {
      if (!path) continue;
      try {
        const info=await stat(path),version=`${info.ino}:${info.mtimeMs}:${info.size}`;
        if(importedFiles.get(path)!==version){await importFile(path);importedFiles.set(path,version);}
      }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
    }
  };
  const decoder: ProgramEventDecoder = decoderPath
    ? (await import(pathToFileURL(resolve(decoderPath)).href)).decoder
    : new GeneratedProgramEventDecoder({snapshots:repositories,proofs:repositories});
  if (!decoder || typeof decoder.decodeFinalized !== 'function') throw new Error('GENERATED_PROGRAM_DECODER_REQUIRED');
  const poller = new FinalizedPoller(store, new KitFinalizedRpc(rpcUrl), decoder, 100, refresh);
  if (process.argv.includes('--follow')) {
    const interval = Number(process.env.ANTE_UP_POLL_INTERVAL_MS ?? '5000');
    if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 300_000) throw new Error('INVALID_POLL_INTERVAL');
    while (true) {
      try { const result=await poller.pollOnce(scope); await heartbeat('indexer',result); console.log(JSON.stringify(result)); }
      catch { console.error('INDEXER_POLL_FAILED'); }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  } else {
    console.log(JSON.stringify(await poller.pollOnce(scope)));
  }
} catch {
  // SDK errors can contain a provider URL with credentials in its path/query.
  console.error('INDEXER_RUN_FAILED');
  process.exitCode = 1;
} finally {
  store.close();
  repositories.close();
}
