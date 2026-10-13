import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const server=await createServer({optimizeDeps:{noDiscovery:true},server:{middlewareMode:true,hmr:false},appType:'custom'});
after(()=>server.close());
const {summaryResult,summaryProof}=await server.ssrLoadModule('/src/sharing/recordSummaryModel.ts');
const {RecordSummary}=await server.ssrLoadModule('/src/sharing/RecordSummary.tsx');
const record={id:'record',proofId:null,finality:'finalized',status:'CLOSED_RESULT',result:{kind:'return',numerator:'-224430482678792022766157802950',denominator:'2546798046646196818142226637040382'},entry:{executedAt:1791851854},exit:{executedAt:1791852201}};
test('real EfCp ratio preserves small loss, exact zero and subprecision directions',()=>{
 assert.equal(summaryResult(record),'−0.01%');
 for(const [n,d,expected] of [['0','1','0.00%'],['1','100000','+0.001%'],['-1','100000000','Decrease <0.0001%'],['1','100000000','Increase <0.0001%'],['1','0','N/A']]) assert.equal(summaryResult({...record,result:{kind:'return',numerator:n,denominator:d}}),expected);
 assert.equal(summaryResult({...record,status:'OPEN',result:null}),'Active');
 assert.equal(summaryResult({...record,status:'CLOSED_NA',result:{kind:'na',reason:'NO_DATA'}}),'N/A');
});
test('summary preserves proof state and includes both dates with no visible long ID',()=>{
 assert.equal(summaryProof(record,null,'devnet'),'Proof pending');
 const invalid={id:'p',recordId:record.id,state:'INVALID'};
 assert.equal(summaryProof({...record,proofId:'p'},invalid,'devnet'),'Proof invalid');
 assert.equal(summaryProof({...record,proofId:'p'},{...invalid,state:'ISSUED'},'devnet'),'Proof pending');
 assert.equal(summaryProof(record,null,'devnet',false,true),'Proof status unavailable');
 const html=renderToStaticMarkup(React.createElement(RecordSummary,{record,title:'solana',proof:null,mode:'devnet'}));
 assert.match(html,/−0.01%/);assert.match(html,/00:37/);assert.match(html,/00:43/);assert.match(html,/Closed · finalized/);assert.match(html,/Proof pending/);assert.match(html,/href="#record-proof"/);assert.doesNotMatch(html,/SAS issued|CHIP RECORD \//);
});
