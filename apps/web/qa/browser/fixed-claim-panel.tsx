import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FinancialMarket} from '../../src/Financial';
import {heldMarket} from '../../src/marketRefresh';
import test,{assert} from './test-runtime.mjs';
import {resetPanel,faucetControl,wallet,counters,finishUnknown} from './panel-adapter';
const pause=()=>new Promise(r=>setTimeout(r,50));
const market:any={id:'Stake11111111111111111111111111111111111111',keyword:'fixed claim fixture',phase:'INDEXED',dataStatus:'VALID',chain:{cluster:'devnet',address:'Stake11111111111111111111111111111111111111'},price:{kind:'indexed',atoms:'1000000',executable:true},capabilities:{claim:{allowed:true,reason:null},openPro:{allowed:true,reason:null}}};

for(const condition of ['REFRESH','RPC_ERROR','SYNCING','STALE'])test(`fixed claim quote/sign can proceed during ${condition} while pending requests remain protected`,async()=>{
 resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);let update:any;
 faucetControl.portfolio=async()=>({wallet:wallet.address,quoteBalanceAtoms:'0',tokenBalances:[],positions:[],lpShares:[],claims:[{id:'fixture-claim',marketId:market.id,owner:wallet.address,status:'UNPAID',payoutAtoms:'10000000',refundAtoms:'217844'}]});
 function Harness(){const [state,setState]=useState('CURRENT');update=setState;
   return <FinancialMarket market={state==='CURRENT'?market:{...heldMarket(market),priceReadiness:{state:['REFRESH','RPC_ERROR'].includes(state)?'UNAVAILABLE':state,dataThrough:1}}} section="pro" refreshBlocked={['REFRESH','RPC_ERROR'].includes(state)} onFinalized={()=>{}}/>;}
 const button=(label:string)=>[...div.querySelectorAll('button')].find(b=>b.textContent?.trim()===label)!;
 const click=(label:string)=>{assert.ok(button(label)&&!button(label).disabled,label+' should be enabled');button(label).click();};
 try{
  root.render(<Harness/>);await pause();click('Claim payout');await pause();click('View my balances');await pause();
  const select=div.querySelector('select')!;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(select,'fixture-claim');select.dispatchEvent(new Event('change',{bubbles:true}));await pause();
  update(condition);await pause();click('Claim payout · review quote');await pause();
  assert.equal(counters.quotes,1);assert.ok(div.textContent!.includes('Review quote before signing'));
  click('Review and sign in wallet');await pause();assert.equal(counters.signs,1);
  update('CURRENT');await pause();update(condition);await pause();
  assert.ok(button('Check existing request').disabled);assert.equal(counters.signs,1);
  finishUnknown();await pause();click('Check existing request');await pause();
  assert.ok(div.textContent!.includes('browser-pending-1'));assert.equal(counters.signs,1);
  assert.ok(button('Claim payout · review quote').disabled);button('Claim payout · review quote').click();await pause();
  assert.equal(counters.quotes,1,'UNKNOWN must not permit a replacement quote');
 }finally{root.unmount();div.remove();}
});

for(const section of ['money','pro','lp'] as const)test(`price-dependent ${section} actions remain blocked during syncing`,async()=>{
 resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 const eligible={...market,capabilities:{...market.capabilities,spotBuy:{allowed:true},depositLP:{allowed:true}}};
 try{
  root.render(<FinancialMarket market={heldMarket(eligible)!} section={section} refreshBlocked={false} onFinalized={()=>{}}/>);await pause();
  const quote=[...div.querySelectorAll('button')].find(b=>b.textContent?.includes('· review quote'))!;
  assert.ok(quote?.disabled);quote.click();await pause();assert.equal(counters.quotes,0);assert.equal(counters.signs,0);
 }finally{root.unmount();div.remove();}
});

test('a prepared fixed claim does not survive wallet/market identity changes',async()=>{
 resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 let context:any=market,section:'pro'|'money'='pro';
 faucetControl.portfolio=async()=>({wallet:wallet.address,quoteBalanceAtoms:'0',tokenBalances:[],positions:[],lpShares:[],claims:[{id:'fixture-claim',marketId:market.id,owner:wallet.address,status:'UNPAID',payoutAtoms:'10000000',refundAtoms:'0'}]});
 const render=()=>root.render(<FinancialMarket market={context} section={section} onFinalized={()=>{}}/>);
 const click=(label:string)=>[...div.querySelectorAll('button')].find(b=>b.textContent?.trim()===label)!.click();
 try{
  render();await pause();click('Claim payout');await pause();click('View my balances');await pause();
  const select=div.querySelector('select')!;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(select,'fixture-claim');select.dispatchEvent(new Event('change',{bubbles:true}));await pause();
  click('Claim payout · review quote');await pause();assert.ok(div.textContent!.includes('Review quote before signing'));
  section='money';render();await pause();assert.ok(!div.textContent!.includes('Review quote before signing'));
  section='pro';render();await pause();click('Claim payout');await pause();click('View my balances');await pause();
  const selectedAgain=div.querySelector('select')!;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(selectedAgain,'fixture-claim');selectedAgain.dispatchEvent(new Event('change',{bubbles:true}));await pause();
  click('Claim payout · review quote');await pause();assert.ok(div.textContent!.includes('Review quote before signing'));
  wallet.cluster='mainnet';render();await pause();
  assert.ok(![...div.querySelectorAll('button')].some(b=>b.textContent?.trim()==='Review and sign in wallet'&&!b.disabled));
  wallet.cluster='devnet';wallet.address=market.id;context={...market,id:'Vote111111111111111111111111111111111111111',chain:{cluster:'devnet',address:'Vote111111111111111111111111111111111111111'}};
  render();await pause();assert.ok(!div.textContent!.includes('Review quote before signing'));
  const selected=div.querySelector('select');assert.ok(!selected||![...selected.options].some(o=>o.value==='fixture-claim'));
  assert.equal(counters.signs,0);
 }finally{root.unmount();div.remove();}
});

for(const kind of ['foreign','paid'])test(`${kind} claims cannot obtain a quote during a price refresh`,async()=>{
 resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 faucetControl.portfolio=async()=>({wallet:wallet.address,quoteBalanceAtoms:'0',tokenBalances:[],positions:[],lpShares:[],claims:[{id:'fixture-claim',marketId:market.id,owner:kind==='foreign'?market.id:wallet.address,status:kind==='paid'?'PAID':'UNPAID',payoutAtoms:'10000000',refundAtoms:'0'}]});
 try{
  root.render(<FinancialMarket market={heldMarket(market)!} section="pro" refreshBlocked={true} onFinalized={()=>{}}/>);await pause();
  [...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Claim payout')!.click();await pause();
  [...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='View my balances')!.click();await pause();
  const select=div.querySelector('select');assert.ok(!select||![...select.options].some(o=>o.value==='fixture-claim'));
  const quote=[...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Claim payout · review quote');quote?.click();await pause();
  assert.equal(counters.quotes,0);assert.equal(counters.signs,0);
 }finally{root.unmount();div.remove();}
});
