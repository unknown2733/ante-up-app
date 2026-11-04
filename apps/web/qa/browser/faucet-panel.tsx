import React from 'react';
import {createRoot} from 'react-dom/client';
import {FinancialFaucet,FinancialMarket,FinancialRegistration,PrivateFinancialPanel} from '../../src/Financial';
import test,{assert} from './test-runtime.mjs';
import {resetPanel,faucetControl,readySol,wallet,counters,finishUnknown} from './panel-adapter';
const pause=()=>new Promise(r=>setTimeout(r,50));
function setup(){
 resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 let finalized=0;
 const render=()=>root.render(<FinancialFaucet onFinalized={()=>finalized++}/>);
 const button=(label:string)=>[...div.querySelectorAll('button')].find(b=>b.textContent?.trim()===label)!;
 return {div,render,button,finalized:()=>finalized,close:()=>{root.unmount();div.remove();}};
}
test('new visitor waits for fee readiness; readiness failure and wrong network do not request a tUSD quote',async()=>{
 const f=setup();let resolve:any;
 faucetControl.readiness=()=>new Promise(r=>{resolve=r;});
 try{
  f.render();await pause();assert.ok(f.button('Check eligibility and quote').disabled,'SOL readiness must finish before requesting tUSD');
  resolve(readySol);await pause();assert.ok(!f.button('Check eligibility and quote').disabled);
  wallet.cluster='mainnet';f.render();await pause();
  assert.ok(f.button('Check eligibility and quote').disabled,'Wrong network must block quoting');
  f.button('Check eligibility and quote').click();await pause();assert.equal(counters.quotes,0);
  wallet.cluster='devnet';faucetControl.readiness=async()=>{throw Error('Fixture readiness unavailable');};f.render();await pause();
  assert.ok(f.button('Check eligibility and quote').disabled,'Failed fee readiness must not authorize a quote');
 }finally{f.close();}
});
test('needs-SOL and disconnected visitors cannot quote; reconnect refreshes eligibility',async()=>{
 const f=setup();faucetControl.readiness=async()=>({...readySol,needsSol:true,balanceLamports:'0',serverGrantAvailable:true,grantUnavailableReason:null});
 try{
  f.render();await pause();assert.ok(f.button('Check eligibility and quote').disabled);
  faucetControl.connected=false;f.render();await pause();assert.ok(f.button('Check eligibility and quote').disabled);
  faucetControl.connected=true;faucetControl.readiness=async()=>readySol;f.render();await pause();
  assert.ok(!f.button('Check eligibility and quote').disabled);
 }finally{f.close();}
});
test('late SOL UNKNOWN completion cannot report an old request in a replacement wallet',async()=>{
 const f=setup();let resolve:any;
 faucetControl.readiness=async()=>({...readySol,needsSol:true,balanceLamports:'0',serverGrantAvailable:true,grantUnavailableReason:null});
 faucetControl.claim=()=>new Promise(r=>{resolve=r;});
 try{
  f.render();await pause();f.button('Get Devnet SOL').click();await pause();assert.equal(counters.solClaims,1);
  wallet.address='Stake11111111111111111111111111111111111111';faucetControl.readiness=async()=>readySol;f.render();await pause();
  resolve({state:'UNKNOWN',signature:null,amountLamports:'20000000'});await pause();
  assert.ok(!f.div.textContent!.includes('SOL request pending'),'Previous wallet completion leaked into current wallet');
  assert.ok(!f.button('Refresh SOL balance').disabled);
 }finally{f.close();}
});

for(const panel of ['market','registration'])test(`${panel} late signer results stay with their owner and UNKNOWN survives return`,async()=>{
 resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 const owner=wallet.address;
 const market:any={id:'Stake11111111111111111111111111111111111111',keyword:'fixture',phase:'INDEXED',chain:{cluster:'devnet',address:'Stake11111111111111111111111111111111111111'},capabilities:{spotBuy:{allowed:true}}};
 const render=()=>root.render(panel==='market'?<FinancialMarket market={market} section="money" onFinalized={()=>{}}/>:<FinancialRegistration onFinalized={()=>{}}/>);
 const click=(label:string)=>{const b=[...div.querySelectorAll('button')].find(b=>b.textContent?.trim()===label)!;assert.ok(b&&!b.disabled,label);b.click();};
 try{
  render();await pause();const input=div.querySelector('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,panel==='market'?'1':'fixture');input.dispatchEvent(new Event('input',{bubbles:true}));await pause();
  click(panel==='market'?'Buy spot · review quote':'Review registration quote');await pause();click('Review and sign in wallet');await pause();
  wallet.address=market.id;render();await pause();
  finishUnknown();await pause();assert.ok(!div.textContent!.includes('Fixture request remains unresolved'));
  wallet.address=owner;render();await pause();click('Check existing request');await pause();
  assert.ok(div.textContent!.includes('Fixture request remains unresolved'));assert.equal(counters.signs,1);
 }finally{root.unmount();div.remove();}
});

test('old registration quote completion cannot release the replacement wallet busy state',async()=>{
 resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 const requests:any[]=[];faucetControl.quote=()=>new Promise(resolve=>requests.push(resolve));
 const render=()=>root.render(<FinancialRegistration onFinalized={()=>{}}/>);
 const quote=()=>[...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Review registration quote')!.click();
 try{
  render();await pause();quote();await pause();
  wallet.address='Stake11111111111111111111111111111111111111';render();await pause();quote();await pause();
  assert.equal(requests.length,2);
  requests[0]({kind:'notExecutable',reason:'old wallet failure'});await pause();
  assert.ok([...div.querySelectorAll('button')].some(b=>b.textContent?.trim()==='Checking…'&&b.disabled));
  assert.ok(!div.textContent!.includes('old wallet failure'));
  requests[1]({kind:'notExecutable',reason:'current wallet result'});await pause();
  assert.ok(div.textContent!.includes('current wallet result'));
 }finally{root.unmount();div.remove();}
});

test('private portfolio ignores a late former-wallet response and retains the current wallet balance',async()=>{
 resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);const requests:any[]=[];
 faucetControl.portfolio=()=>new Promise(resolve=>requests.push(resolve));
 const render=()=>root.render(<PrivateFinancialPanel wallet={wallet.address} refresh={0}/>);
 const click=()=>[...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='View balances')!.click();
 const portfolio=(owner:string,balance:string)=>({wallet:owner,quoteBalanceAtoms:balance,tokenBalances:[],positions:[],claims:[],lpShares:[]});
 try{
  const owner=wallet.address;render();await pause();click();await pause();
  wallet.address='Stake11111111111111111111111111111111111111';render();await pause();click();await pause();
  requests[1](portfolio(wallet.address,'2000000'));await pause();
  assert.equal(div.querySelector('.finance-facts strong')?.textContent,'2 tUSD');
  requests[0](portfolio(owner,'1000000'));await pause();
  assert.equal(div.querySelector('.finance-facts strong')?.textContent,'2 tUSD');
 }finally{root.unmount();div.remove();}
});

for(const bad of ['0','-1','1.0000001'])test(`invalid trade amount ${bad} does not request a quote`,async()=>{
 resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 const market:any={id:'Stake11111111111111111111111111111111111111',keyword:'fixture',phase:'INDEXED',chain:{cluster:'devnet',address:'Stake11111111111111111111111111111111111111'},capabilities:{spotBuy:{allowed:true}}};
 try{
  root.render(<FinancialMarket market={market} section="money" onFinalized={()=>{}}/>);await pause();
  const input=div.querySelector('input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,bad);input.dispatchEvent(new Event('input',{bubbles:true}));await pause();
  [...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Buy spot · review quote')!.click();await pause();
  assert.equal(counters.quotes,0);assert.equal(counters.signs,0);
 }finally{root.unmount();div.remove();}
});

test('market/tab changes do not receive an older signer result while its wallet request remains pending',async()=>{
 resetPanel();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 let id='Stake11111111111111111111111111111111111111',section:'money'|'pro'='money';
 const render=()=>root.render(<FinancialMarket market={{id,keyword:'fixture',phase:'INDEXED',chain:{cluster:'devnet',address:id},capabilities:{spotBuy:{allowed:true},openPro:{allowed:true}}} as any} section={section} onFinalized={()=>{}}/>);
 try{
  render();await pause();const input=div.querySelector('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'1');input.dispatchEvent(new Event('input',{bubbles:true}));await pause();
  [...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Buy spot · review quote')!.click();await pause();
  [...div.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Review and sign in wallet')!.click();await pause();
  id='Vote111111111111111111111111111111111111111';section='pro';render();await pause();finishUnknown();await pause();
  assert.ok(!div.textContent!.includes('Fixture request remains unresolved'));
  assert.ok(div.textContent!.includes('browser-pending-1'));assert.equal(counters.signs,1);
 }finally{root.unmount();div.remove();}
});

test('insufficient balance quote rejection stays visible and never offers a signer',async()=>{
 const f=setup();faucetControl.quote=async()=>({kind:'notExecutable',reason:'Insufficient test balance.'});
 try{
  f.render();await pause();f.button('Check eligibility and quote').click();await pause();
  assert.equal(counters.quotes,1);assert.equal(counters.signs,0);
  assert.ok(!f.button('Sign in wallet'));assert.ok(!f.div.textContent!.includes('Review payout terms'));
  assert.ok(f.div.querySelector('.notice'));
 }finally{f.close();}
});
test('late tUSD signer result cannot overwrite a replacement wallet; UNKNOWN can still be rechecked',async()=>{
 const f=setup();
 try{
  f.render();await pause();f.button('Check eligibility and quote').click();await pause();f.button('Sign in wallet').click();await pause();
  assert.equal(counters.signs,1);
  wallet.address='Stake11111111111111111111111111111111111111';f.render();await pause();
  finishUnknown();await pause();assert.ok(!f.div.textContent!.includes('Fixture request remains unresolved'),'Previous wallet outcome leaked');
  assert.equal(counters.signs,1);
 }finally{f.close();}
});
test('existing SOL UNKNOWN request remains available when a new grant is unavailable',async()=>{
 const f=setup();faucetControl.solPending='existing-sol-request';
 faucetControl.readiness=async()=>({...readySol,needsSol:true,balanceLamports:'0',grantUnavailableReason:'COOLDOWN'});
 try{
  f.render();await pause();f.button('Check existing SOL request').click();await pause();
  assert.equal(counters.solRechecks,1);assert.equal(counters.solClaims,0);
  assert.ok(f.div.textContent!.includes('SOL request pending'));
 }finally{f.close();}
});
