import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChipCompletion} from '../../src/consumer-ui/ChipCompletion';
import {RecordSummary} from '../../src/sharing/RecordSummary';
import {ResultCardShare} from '../../src/sharing/ResultCardShare';
import {createResultCard} from '../../src/sharing/resultCard';
import test,{assert} from './test-runtime.mjs';

const point={executedAt:1793700000,slot:'1',signature:'isolated-fixture',snapshot:null,h:{numerator:'100',denominator:'1'},unavailableReason:null};
const record:any={id:'qa-local:visitor-result',wallet:'Vote111111111111111111111111111111111111111',marketId:'qa-local:visitor',direction:'up',entry:point,
 exit:{...point,executedAt:1793700300},status:'CLOSED_RESULT',result:{kind:'return',numerator:'-3',denominator:'100'},finality:'finalized',proofId:null};
const pause=()=>new Promise(r=>setTimeout(r,50));

test('closed chip completion and record summary generate real PNG bytes and isolated sharing payload',async()=>{
 const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 const originalFetch=globalThis.fetch,clipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard'),share=Object.getOwnPropertyDescriptor(navigator,'share'),canShare=Object.getOwnPropertyDescriptor(navigator,'canShare');
 let payload:any=null,copied='';
 globalThis.fetch=(...args:any[])=>String(args[0]).includes('/brand/')?Promise.resolve(new Response('',{status:404})):originalFetch(...args as Parameters<typeof fetch>);
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value;}}});
 Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
 Object.defineProperty(navigator,'share',{configurable:true,value:async(value:any)=>{payload=value;}});
 const restore=(name:string,descriptor:PropertyDescriptor|undefined)=>descriptor?Object.defineProperty(navigator,name,descriptor):delete (navigator as any)[name];
 try{
  const card=createResultCard(record,'Isolated visitor fixture','devnet',null)!;
  root.render(<><ChipCompletion title="Isolated visitor fixture" record={record}><span>Fixture result</span></ChipCompletion><RecordSummary record={record} title="Isolated visitor fixture" mode="devnet" proof={null} loading={false} unavailable={false}/><ResultCardShare data={card}/></>);
  await pause();assert.ok(div.textContent!.includes('−3.00%'));assert.ok(!div.textContent!.includes('SAS issued'));
  [...div.querySelectorAll('button')].find(b=>b.textContent?.includes('Create result card'))!.click();
  for(let i=0;i<40&&!div.querySelector('a[download]');i++)await pause();
  assert.ok(div.querySelector('a[download]'),'PNG generation failed');
  [...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Share image')!.click();await pause();
  assert.equal(payload.files[0].type,'image/png');
  const bytes=new Uint8Array(await payload.files[0].arrayBuffer());assert.deepEqual([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);
  assert.ok(payload.text.includes('Not a cash return.'));
  [...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Copy record link')!.click();await pause();assert.equal(copied,card.url);
 }finally{root.unmount();div.remove();globalThis.fetch=originalFetch;restore('clipboard',clipboard);restore('share',share);restore('canShare',canShare);}
});

test('open and unconfirmed records cannot share final results; closed N/A stays explicit',()=>{
 assert.equal(createResultCard({...record,status:'OPEN',exit:null},'fixture','devnet',null),null);
 assert.equal(createResultCard({...record,finality:'confirmed'},'fixture','devnet',null),null);
 const na=createResultCard({...record,status:'CLOSED_NA',result:{kind:'na',reason:'SOURCE_UNAVAILABLE'}},'fixture','devnet',null)!;
 assert.equal(na.result,'N/A');assert.equal(na.proof,'Proof pending');
});
