// Copy into ignored .runtime/collection/publisher.local.mjs after building
// clients/chain. Node 24 can import D's src/sqlite.ts directly.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const required=name=>{const value=process.env[name];if(!value)throw new Error(`MISSING_${name}`);return value;};
export const endpoint=required('ANTE_UP_RPC_URL');
export const programId=required('ANTE_UP_PROGRAM_ID');
export const cluster=required('ANTE_UP_CLUSTER');
if (!['localnet','devnet'].includes(cluster)) throw new Error('INVALID_CLUSTER');
const {SqliteProjectionStore}=await import(pathToFileURL(resolve(required('ANTE_UP_INDEXER_MODULE'))).href);
export const projection=new SqliteProjectionStore(required('ANTE_UP_INDEX_DB'));
const signers=await import(pathToFileURL(resolve(required('ANTE_UP_SIGNER_MODULE'))).href);
export const publisherSigner=signers.publisherSigner;
export const feePayer=signers.feePayer?.address??publisherSigner?.address;
if (!publisherSigner?.address || !feePayer) throw new Error('PUBLISH_SIGNER_REQUIRED');
