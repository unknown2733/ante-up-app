// Copy into ignored .runtime/evidence/runtime.local.mjs after building
// clients/chain. Node 24 can import D's src/sqlite.ts directly.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const required=name=>{const value=process.env[name];if(!value)throw new Error(`MISSING_${name}`);return value;};
export const endpoint=required('ANTE_UP_RPC_URL');
export const programId=required('ANTE_UP_PROGRAM_ID');
const cluster=required('ANTE_UP_CLUSTER');
if (!['localnet','devnet'].includes(cluster)) throw new Error('INVALID_CLUSTER');
export const scope={cluster,programId};
const {SqliteProjectionStore}=await import(pathToFileURL(resolve(required('ANTE_UP_INDEXER_MODULE'))).href);
export const projection=new SqliteProjectionStore(required('ANTE_UP_INDEX_DB'));
export const credential=required('ANTE_UP_SAS_CREDENTIAL');
export const schema=required('ANTE_UP_SAS_SCHEMA');
export const attestationExpiry=Number(required('ANTE_UP_SAS_EXPIRY_UNIX'));
if (!Number.isSafeInteger(attestationExpiry) || attestationExpiry<=Math.floor(Date.now()/1000))
  throw new Error('ATTESTATION_EXPIRY_REQUIRED');
const signers=await import(pathToFileURL(resolve(required('ANTE_UP_SIGNER_MODULE'))).href);
export const payer=signers.payer;
export const authority=signers.authority;
export const proofAuthority=signers.proofAuthority;
export const turboPrivateKey=signers.turboPrivateKey;
export const verifyTurboReceipt=signers.verifyTurboReceipt;
if (![payer,authority,proofAuthority].every(s=>s?.address) || !turboPrivateKey ||
  typeof verifyTurboReceipt!=='function') throw new Error('EVIDENCE_SIGNER_OR_RECEIPT_VERIFIER_REQUIRED');
