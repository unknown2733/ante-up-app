/** Read-only container preflight; opens no signer and submits no transaction. */
import {readFile} from 'node:fs/promises';
const rpcFile=process.env.ANTE_UP_RPC_URL_FILE;
const scope=process.env.ANTE_UP_KEEPER_SCOPE;
const journal=process.env.ANTE_UP_KEEPER_JOURNAL;
const genesis=process.env.ANTE_UP_KEEPER_GENESIS_HASH;
if (!rpcFile || !scope || !journal || !genesis) throw new Error('KEEPER_PREFLIGHT_CONFIGURATION_INCOMPLETE');
const rpc=(await readFile(rpcFile,'utf8')).trim();
if (!rpc) throw new Error('KEEPER_RPC_URL_EMPTY');
process.argv=[process.argv[0],'services/api/src/keeper-run.ts','--scope',scope,'--journal',journal,
  '--rpc',rpc,'--expected-genesis-hash',genesis];
await import('../../api/src/keeper-run.ts');
