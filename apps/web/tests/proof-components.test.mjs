import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('proof and execution components render links only for eligible states, with pending recovery intact',async()=>{
 const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{middlewareMode:true},appType:'custom'});
 try {
  const {RecordEvidence}=await server.ssrLoadModule('/src/sharing/RecordEvidence.tsx');
  const {ExecutionResult}=await server.ssrLoadModule('/src/sharing/ChipExecutionResult.tsx');
  const id='CjbpsPJJyqKBxoAmUcMTet5HNXz6hQxeeHquAN4afJTN';
  const point={signature:'1'.repeat(64),executedAt:1,slot:'1',h:null,snapshot:null,unavailableReason:null};
  const record={id,proofId:'proof',finality:'finalized',status:'CLOSED_RESULT',entry:point,exit:point};
  const ref={contentHash:'a'.repeat(64),arweaveItemId:'A'.repeat(43),parentTransactionId:'B'.repeat(43)};
  const proof={id:'proof',recordId:id,state:'ISSUED',payloadHash:'a'.repeat(64),manifestRef:ref,evidence:[ref],sasId:id,confirmations:20};
  const render=props=>renderToStaticMarkup(React.createElement(RecordEvidence,{record,mode:'devnet',proof,...props}));
  const issued=render({});
  assert.match(issued,/SAS issued/);assert.match(issued,/Evidence manifest/);assert.match(issued,/Source \/ calculation artifact 1/);assert.match(issued,/rel="noopener noreferrer"/);
  const pending=render({proof:{...proof,state:'CONFIRMING',confirmations:19}});
  assert.match(pending,/Waiting for storage confirmations/);assert.match(pending,/19 \/ 20/);assert.doesNotMatch(pending,/href="https:\/\/arweave/);
  assert.doesNotMatch(render({mode:'fixture'}),/href="https:/);
  assert.doesNotMatch(render({unavailable:true}),/href="https:\/\/arweave|SAS issued/);
  const success=renderToStaticMarkup(React.createElement(ExecutionResult,{mode:'devnet',action:'closeFree',outcome:{state:'FINALIZED',signature:point.signature,recordId:id,requestId:'request'}}));
  assert.match(success,/View result/);assert.match(success,/\/records\/Cjbps/);
  const uncertain=renderToStaticMarkup(React.createElement(ExecutionResult,{mode:'devnet',action:'closeFree',outcome:{state:'UNKNOWN',signature:point.signature,recordId:id,requestId:'request'}}));
  assert.match(uncertain,/Check the existing request/);assert.doesNotMatch(uncertain,/View result|View transaction/);
 } finally {await server.close();}
});
