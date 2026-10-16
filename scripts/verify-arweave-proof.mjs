// Public-network, read-only archive audit. Requires state and one record ID;
// never loads a payer, issuer, Turbo upload key or authenticated Turbo client.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createTurboStorageAdapter} from '../services/evidence/turbo.mjs';
import {createArweaveInclusionVerifier} from '../services/evidence/inclusion.mjs';
import {createReceiptVerifier} from '../services/evidence/receipt.mjs';
import {verifyArchivedJob} from '../services/evidence/proof-audit.mjs';

const directory=process.env.ANTE_UP_LIVE_DIRECTORY,recordId=process.env.ANTE_UP_RECORD_ID;
if(!directory||!recordId||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recordId))throw Error('AUDIT_INPUT_REQUIRED');
const jobs=JSON.parse(await readFile(join(directory,'evidence/jobs.json'),'utf8'));
const job=jobs[`proof:${recordId}:original`];
if(!job)throw Error('AUDIT_JOB_REQUIRED');
const storage=createTurboStorageAdapter({
 turbo:{upload:async()=>{throw Error('AUDIT_READ_ONLY');}},
 receiptVerifier:createReceiptVerifier({allowedAddresses:['JNC6vBhjHY1EPwV3pEeNmrsgFMxH5d38_LHsZ7jful8']}),
 inclusionVerifier:createArweaveInclusionVerifier()
});
console.log(JSON.stringify(await verifyArchivedJob(job,storage)));
