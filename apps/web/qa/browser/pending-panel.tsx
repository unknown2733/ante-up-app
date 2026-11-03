import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FinancialMarket} from '../../src/Financial';
import {heldMarket} from '../../src/marketRefresh';
import test,{assert} from './test-runtime.mjs';
import {resetPanel,finishUnknown,counters} from './panel-adapter';
const pause=()=>new Promise(r=>setTimeout(r,50));
test('mounted financial panel retains pending request and busy state across refresh, without another signature',async()=>{
  resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
  const market:any={id:'Stake11111111111111111111111111111111111111',keyword:'fixture',phase:'INDEXED',dataStatus:'VALID',supported:true,chain:{cluster:'devnet',address:'Stake11111111111111111111111111111111111111'},price:{kind:'indexed',atoms:'1000000',executable:true},capabilities:{spotBuy:{allowed:true,reason:null},spotSell:{allowed:true,reason:null}}};
  let refresh:any;
  function Harness(){const [loading,setLoading]=useState(false);refresh=setLoading;return <FinancialMarket market={loading?heldMarket(market)!:market} section="money" refreshBlocked={loading} onFinalized={()=>{}}/>;}
  const click=(label:string)=>{const button=[...div.querySelectorAll('button')].find(b=>b.textContent?.trim()===label);assert.ok(button&&!button.disabled,'Missing enabled '+label);button!.click();};
  try{
    root.render(<Harness/>);await pause();
    const input=div.querySelector('input')!;assert.ok(input);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'1');input.dispatchEvent(new Event('input',{bubbles:true}));await pause();
    click('Buy spot · review quote');await pause();click('Review and sign in wallet');await pause();assert.equal(counters.signs,1);
    refresh(true);await pause();assert.ok(div.textContent!.includes('browser-pending-1'));
    assert.ok([...div.querySelectorAll('button')].filter(b=>b.textContent?.includes('Check existing request')).every(b=>b.disabled));
    refresh(false);await pause();assert.ok(div.textContent!.includes('browser-pending-1'));assert.equal(counters.signs,1);
    finishUnknown();await pause();click('Check existing request');await pause();
    refresh(true);await pause();refresh(false);await pause();
    assert.ok(div.textContent!.includes('browser-pending-1'));assert.equal(counters.signs,1);
  }finally{root.unmount();div.remove();}
});

for(const readiness of ['SYNCING','STALE'])test(`a prepared quote cannot start a new signature after ${readiness}`,async()=>{
  resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
  let update:any;
  const market:any={id:'Stake11111111111111111111111111111111111111',keyword:'fixture',phase:'INDEXED',dataStatus:'VALID',supported:true,chain:{cluster:'devnet',address:'Stake11111111111111111111111111111111111111'},price:{kind:'indexed',atoms:'1000000',executable:true},capabilities:{spotBuy:{allowed:true,reason:null},spotSell:{allowed:true,reason:null}}};
  function Harness(){const [held,setHeld]=useState(false);update=setHeld;return <FinancialMarket market={held?{...heldMarket(market),priceReadiness:{state:readiness,dataThrough:1}}:market} section="money" refreshBlocked={false} onFinalized={()=>{}}/>;}
  try{
    root.render(<Harness/>);await pause();
    const input=div.querySelector('input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'1');input.dispatchEvent(new Event('input',{bubbles:true}));await pause();
    [...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Buy spot · review quote')!.click();await pause();
    assert.ok(div.textContent!.includes('Review quote before signing'));
    update(true);await pause();
    const sign=[...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Review and sign in wallet');
    assert.ok(sign?.disabled,'Prepared quote must block a new signature during '+readiness);
    sign!.click();await pause();assert.equal(counters.signs,0);
  }finally{root.unmount();div.remove();}
});
