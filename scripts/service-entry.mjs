import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const entry=process.argv[2];
const allowed=new Set(['scripts/collect-devnet.mjs','services/indexer/src/run.ts','services/api/src/server.ts']);
if(!allowed.has(entry))throw Error('INVALID_SERVICE');
try {
  process.env.ANTE_UP_RPC_URL=(await readFile(process.env.ANTE_UP_RPC_URL_FILE,'utf8')).trim();
  if (process.env.ANTE_UP_RPC_FALLBACK_URL_FILE)
    process.env.ANTE_UP_RPC_FALLBACK_URL=(await readFile(process.env.ANTE_UP_RPC_FALLBACK_URL_FILE,'utf8')).trim();
  process.argv=[process.argv[0],resolve(entry),...process.argv.slice(3)];
  await import(pathToFileURL(resolve(entry)).href);
}catch{console.error('SERVICE_START_FAILED');process.exitCode=1;}
