import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server=await createServer({root,optimizeDeps:{noDiscovery:true},server:{middlewareMode:true,hmr:false},appType:'custom'});
after(()=>server.close());
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props));
const id='7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT';
const market={id,keyword:'solana',snapshot:{finality:'finalized',payload:{marketId:id,formulaVersion:'h3-d7-q12-v1',queryVersion:'1',queryHash:'e90d17a9452f18411f83cec70f7c32e3414770b8aca80ab1b0572ae311aa9c9d'}}};
test('X source requires the verified market, query, formula and finality; unknown and generated inputs stay distinct', async()=>{
 const {attentionContext,AttentionContext}=await server.ssrLoadModule('/src/consumer-ui/AttentionContext.tsx');
 assert.equal(attentionContext(market).xCounts,true);
 for(const changed of [{...market,id:'other'},{...market,dataProvenance:'SYNTHETIC_QA'},{...market,snapshot:{...market.snapshot,finality:'confirmed'}},{...market,snapshot:{...market.snapshot,payload:{...market.snapshot.payload,queryHash:'wrong'}}},{...market,snapshot:{...market.snapshot,payload:{...market.snapshot.payload,formulaVersion:'unknown'}}}])assert.equal(!!attentionContext(changed).xCounts,false);
 const html=render(AttentionContext,{market,observedAtMs:Date.UTC(2026,9,13,1,20)});
 assert.match(html,/X post counts/);assert.match(html,/7 days earlier/);assert.match(html,/2026-10-13T01:20:00.000Z/);assert.match(html,/data-pricing#attention-reference/);assert.match(html,/Published snapshot/);assert.match(html,/not those raw files/);
 assert.doesNotMatch(render(AttentionContext,{market:{...market,dataProvenance:'SYNTHETIC_QA'},observedAtMs:null}),/X post counts/);
});
test('finalized chip summary displays the record time and never invents an unprojected time',async()=>{
 const {ChipCompletion}=await server.ssrLoadModule('/src/consumer-ui/ChipCompletion.tsx');
 const html=render(ChipCompletion,{title:'solana',record:{entry:{executedAt:1791854400},exit:null},children:React.createElement('a',{href:'/records/real-record'},'View record')});
 assert.match(html,/solana/);assert.match(html,/1 chip · Finalized/);assert.match(html,/2026-10-13T01:20:00.000Z/);assert.match(html,/View record/);
 const pending=render(ChipCompletion,{title:'solana',record:null});assert.match(pending,/Participation time syncing/);assert.doesNotMatch(pending,/<time/);
});
