import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceLinks, proofIsVerified, transactionHref } from '../src/sharing/proofLinks.ts';
import { executionResult } from '../src/sharing/executionResult.ts';
const id='CjbpsPJJyqKBxoAmUcMTet5HNXz6hQxeeHquAN4afJTN';
const signature='1'.repeat(64); // Structurally valid test bytes, never used as a live record.
const point={signature,executedAt:1,slot:'1',snapshot:null,h:null,unavailableReason:null};
const record={id,wallet:id,marketId:id,direction:'up',entry:point,exit:point,status:'CLOSED_RESULT',result:{kind:'return',numerator:'1',denominator:'4'},finality:'finalized',proofId:'proof'};
const ref={contentHash:'a'.repeat(64),arweaveItemId:'A'.repeat(43),parentTransactionId:'B'.repeat(43)};
const proof={id:'proof',recordId:id,payloadHash:'a'.repeat(64),manifestRef:ref,state:'ISSUED',evidence:[ref],confirmations:20,sasId:id,retryAt:null,error:null,replacementId:null};

test('finalized matching evidence exposes fixed-host transactions, attestation and archived artifacts',()=>{
 const links=evidenceLinks(record,proof,'devnet');
 assert.equal(links.length,5);
 assert.ok(links.some(x=>x.label==='SAS attestation'&&x.href.endsWith('?cluster=devnet')));
 assert.ok(links.some(x=>x.label==='Evidence manifest'&&x.href===`https://arweave.net/${ref.arweaveItemId}`));
 for(const mode of ['fixture','localnet',null]) assert.deepEqual(evidenceLinks(record,proof,mode),[]);
 assert.deepEqual(evidenceLinks({...record,finality:'confirmed'},proof,'devnet'),[]);
});
test('pending, mismatched, invalid and incomplete proofs never become external attestation links',()=>{
 for(const changed of [{state:'QUEUED'},{state:'CONFIRMING'},{state:'READY_TO_ISSUE'},{state:'INVALID'},{state:'REPLACED'},{confirmations:19},{confirmations:NaN},{sasId:'sas:example'},{evidence:[]},{evidence:[{...ref,parentTransactionId:null}]},{manifestRef:null},{payloadHash:'nohash'},{payloadHash:'b'.repeat(64)},{recordId:'other'},{id:'other'}]) {
   assert.equal(evidenceLinks(record,{...proof,...changed},'devnet').length,2,JSON.stringify(changed));
 }
 assert.equal(proofIsVerified({...proof,manifestRef:{...ref,arweaveItemId:'javascript:alert(1)'}}),false);
 assert.equal(transactionHref('fixture:signature','devnet'),null);
 assert.equal(transactionHref('https://evil.invalid','devnet'),null);
 assert.equal(transactionHref('1'.repeat(63),'devnet'),null);
});
test('success navigation is finalized-only and recovery never implies retrying an uncertain transaction',()=>{
 const outcome={state:'FINALIZED',requestId:'request',signature,recordId:id};
 assert.equal(executionResult(outcome,'closeFree','devnet').recordHref,`/records/${id}`);
 assert.equal(executionResult(outcome,'closeFree','devnet').recordLabel,'View result');
 assert.equal(executionResult(outcome,'openFree','devnet').recordLabel,'View record');
 for(const state of ['AWAITING_SIGNATURE','SUBMITTED','CONFIRMED','UNKNOWN','FAILED']) assert.equal(executionResult({...outcome,state},'closeFree','devnet').recordHref,null);
 const unknown=executionResult({...outcome,state:'UNKNOWN'},'closeFree','devnet');
 assert.equal(unknown.transactionHref,null);assert.match(unknown.description,/Check the existing request/);
 assert.equal(executionResult({...outcome,state:'FAILED',reason:'expired without execution'},'closeFree','devnet').title,'Request expired.');
 assert.equal(executionResult({...outcome,state:'FAILED',reason:'user cancelled'},'closeFree','devnet').title,'Request cancelled.');
 assert.equal(executionResult({...outcome,recordId:'demo:record'},'closeFree','devnet').recordHref,null);
});
