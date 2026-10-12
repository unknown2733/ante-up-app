/** Container entry: explicit execution gate and file-based RPC secret. */
import {readFile} from 'node:fs/promises';
if (process.env.ANTE_UP_KEEPER_ENABLED!=='yes') throw new Error('KEEPER_DISABLED');
const rpcFile=process.env.ANTE_UP_RPC_URL_FILE;
const scope=process.env.ANTE_UP_KEEPER_SCOPE;
const journal=process.env.ANTE_UP_KEEPER_JOURNAL;
const attempts=process.env.ANTE_UP_KEEPER_ATTEMPTS;
const genesis=process.env.ANTE_UP_KEEPER_GENESIS_HASH;
const publisher=process.env.ANTE_UP_PUBLISHER_KEYPAIR_FILE;
const keeper=process.env.ANTE_UP_KEEPER_KEYPAIR_FILE;
if (!rpcFile || !scope || !journal || !attempts || !genesis || !publisher || !keeper)
  throw new Error('KEEPER_SERVICE_CONFIGURATION_INCOMPLETE');
const rpc=(await readFile(rpcFile,'utf8')).trim();
if (!rpc) throw new Error('KEEPER_RPC_URL_EMPTY');
process.argv=[process.argv[0],'services/api/src/keeper-run.ts','--scope',scope,'--journal',journal,'--rpc',rpc,
  '--expected-genesis-hash',genesis,'--attempts',attempts,'--publisher-keypair',publisher,
  '--keeper-keypair',keeper,'--follow','--execute',
  ...(process.env.ANTE_UP_KEEPER_MAX_PASSES?['--max-passes',process.env.ANTE_UP_KEEPER_MAX_PASSES]:[])];
await import('../../api/src/keeper-run.ts');
