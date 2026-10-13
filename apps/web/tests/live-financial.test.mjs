import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ANTE_UP_PROGRAM_ADDRESS } from '@ante-up/chain-client';
import { getCompiledTransactionMessageEncoder, getTransactionEncoder } from '@solana/kit';

const server = await createServer({ optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => server.close());
const { createLiveFinancialFlow } = await server.ssrLoadModule('/src/liveFinancial.ts');
const wallet = { address: 'Vote111111111111111111111111111111111111111', cluster: 'devnet', supportedTransactionVersions: new Set(['legacy']), signer: { signAndSendTransactions: async () => { throw new Error('must not sign'); } } };
const marketId = 'Stake11111111111111111111111111111111111111';
const now = 1_700_000_000;
const envelope = (data) => new Response(JSON.stringify({ schemaVersion: '0.1', mode: 'devnet', asOf: now, nextCursor: null, data }), { status: 200 });

function setup(reply) {
  const calls = [];
  let current = wallet;
  const storage = new Map();
  const flow = createLiveFinancialFlow({
    baseUrl: '/api', getWallet: () => current,
    authorize: async () => ({ token: 'test-token', wallet: wallet.address, cluster: 'devnet', expiresAt: now + 300 }),
    nowSeconds: () => now, requestId: () => 'request-1',
    storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    fetcher: async (url, init) => { calls.push([url, init]); assert.equal(init.headers.Authorization, 'Bearer test-token'); return reply(url, init); },
  });
  return { flow, calls, storage, setWallet: (value) => { current = value; } };
}

function quote(intent, changes = {}) {
  return {
    id: 'quote-1', intent, chain: { cluster: 'devnet', programId: ANTE_UP_PROGRAM_ADDRESS, address: marketId }, phase: 'INDEXED',
    quotedAt: now, expiresAt: now + 25, configVersion: '1', snapshot: null, stateVersion: '2', priceAtoms: '1000000', grossAtoms: '1000000',
    tradeFeeAtoms: '1000', timePrepaidAtoms: '0', maxPaymentAtoms: '1001000', minReceiveAtoms: '900000', maxPayoutAtoms: null,
    maturityAt: null, executable: true, ...changes,
  };
}

test('accepts semantically identical reordered quote intent and never signs without a verifier', async () => {
  const { flow, calls } = setup((_url, init) => {
    const sent = JSON.parse(init.body);
    return envelope({ kind: 'quote', quote: quote({ quantityAtoms: sent.quantityAtoms, marketId: sent.marketId, action: sent.action, wallet: sent.wallet, requestId: sent.requestId }) });
  });
  const result = await flow.quote({ action: 'spotBuy', marketId, quantityAtoms: '1000000' });
  assert.equal(result.kind, 'quote');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/v1/financial/quotes');
  assert.deepEqual(await flow.execute(result.quote), { state: 'UNAVAILABLE', reason: 'Verified on-chain financial signing or pending-request storage is not available.', requestId: 'request-1', signature: null });
  assert.equal(calls.length, 1);
});

test('rejects changed quote amount and incorrect private portfolio owner', async () => {
  const { flow } = setup((url, init) => {
    if (url.includes('/portfolio')) return envelope({ wallet: marketId, quoteBalanceAtoms: '1', positions: [], claims: [], lpShares: [], tokenBalances: [] });
    const sent = JSON.parse(init.body);
    return envelope({ kind: 'quote', quote: quote({ ...sent, quantityAtoms: '2000000' }) });
  });
  await assert.rejects(flow.quote({ action: 'spotBuy', marketId, quantityAtoms: '1000000' }), /Quote identity/);
  await assert.rejects(flow.portfolio(), /does not match this wallet/);
});

test('accepts past original maturity for claim but rejects expired quotes', async () => {
  let expiresAt = now + 25;
  const { flow } = setup((_url, init) => {
    const sent = JSON.parse(init.body);
    return envelope({ kind: 'quote', quote: quote(sent, { maturityAt: now - 100, expiresAt }) });
  });
  assert.equal((await flow.quote({ action: 'claim', marketId, claimId: 'claim-1' })).kind, 'quote');
  expiresAt = now - 1;
  await assert.rejects(flow.quote({ action: 'claim', marketId, claimId: 'claim-1' }), /expired/);
});

test('expired unlanded response clears only unsigned pending requests for a fresh quote', async () => {
  const {flow,storage,calls}=setup(()=>envelope({requestId:'request-1',wallet:wallet.address,action:'faucet',signature:null,state:'FAILED',error:{code:'REQUOTE_REQUIRED',message:'expired',retryable:true,requestId:'request-1'}}));
  const key=`ante-up-financial-pending:devnet:${wallet.address}`;
  storage.set(key,JSON.stringify({requestId:'request-1',wallet:wallet.address,cluster:'devnet',action:'faucet',marketId:null,signature:null}));
  assert.equal((await flow.recheck()).state,'FAILED');
  assert.equal(flow.pending(wallet),null);
  assert.equal(calls.length,1);
  storage.set(key,JSON.stringify({requestId:'request-1',wallet:wallet.address,cluster:'devnet',action:'faucet',marketId:null,signature:'already-sent'}));
  await assert.rejects(flow.recheck(),/identity/);
  assert.ok(flow.pending(wallet));
});

test('rechecks a recovered uncertain request without sending another transaction', async () => {
  const { flow, storage, calls } = setup((url) => {
    assert.match(url, /\/operations\/request-1\?wallet=/);
    return envelope({ requestId: 'request-1', wallet: wallet.address, action: 'spotSell', signature: 'chain-signature', state: 'FINALIZED', error: null });
  });
  storage.set(`ante-up-financial-pending:devnet:${wallet.address}`, JSON.stringify({ requestId: 'request-1', wallet: wallet.address, cluster: 'devnet', action: 'spotSell', marketId, signature: null }));
  await assert.rejects(flow.quote({ action: 'spotBuy', marketId, quantityAtoms: '1' }), /Resolve the pending/);
  assert.equal((await flow.recheck()).state, 'FINALIZED');
  assert.equal(flow.pending(wallet), null);
  assert.equal(calls.length, 1);
});

test('wallet transport failure keeps UNKNOWN and traces timing without capturing signed content', async () => {
  let sends = 0;
  const secret = 'never-record-this-private-payload';
  const owner = {...wallet,signer:{async signAndSendTransactions(){sends++;throw new Error(secret,{cause:{code:'ERROR_SESSION_CLOSED'}})}}};
  const disk = new Map(); let offered;
  const flow = createLiveFinancialFlow({baseUrl:'/api',getWallet:()=>owner,nowSeconds:()=>now,
    authorize:async()=>({token:secret,wallet:owner.address,cluster:'devnet',expiresAt:now+300}),
    requestId:()=>secret,verifyInstruction:async()=>{},
    storage:{getItem:key=>disk.get(key)??null,setItem:(key,value)=>disk.set(key,value),removeItem:key=>disk.delete(key)},
    fetcher:async(url,init)=>{
      if(url.endsWith('/quotes')) {offered=quote(JSON.parse(init.body));return envelope({kind:'quote',quote:offered})}
      const messageBytes=getCompiledTransactionMessageEncoder().encode({version:'legacy',header:{numSignerAccounts:1,numReadonlySignerAccounts:0,numReadonlyNonSignerAccounts:1},staticAccounts:[owner.address,ANTE_UP_PROGRAM_ADDRESS],lifetimeToken:'11111111111111111111111111111111',instructions:[{programAddressIndex:1,accountIndices:[0],data:new Uint8Array()}]});
      const wire=getTransactionEncoder().encode({messageBytes,signatures:{[owner.address]:null}});
      return envelope({kind:'transaction',wallet:owner.address,cluster:'devnet',programId:ANTE_UP_PROGRAM_ADDRESS,action:'spotBuy',requestId:secret,quote:offered,expiresAt:offered.expiresAt,unsignedTransaction:Buffer.from(wire).toString('base64')});
    }});
  const result=await flow.quote({action:'spotBuy',marketId,quantityAtoms:'1000000'});
  const outcome=await flow.execute(result.quote);
  assert.equal(outcome.state,'UNKNOWN'); assert.equal(sends,1); assert.ok(flow.pending(owner));
  assert.equal((await flow.execute(result.quote)).state,'UNAVAILABLE'); assert.equal(sends,1);
  const marks=performance.getEntriesByType('mark').filter(entry=>entry.name.startsWith('ante-up.financial.'));
  const last=marks.at(-1); const prefix=last.name.slice(0,last.name.indexOf('.wallet.failed'));
  const trace=marks.filter(entry=>entry.name.startsWith(prefix+'.'));
  assert.deepEqual(trace.map(entry=>entry.detail.phase),['quote.start','quote.ready','prepare.start','prepare.ready','verify.start','verify.ready','wallet.start','wallet.failed']);
  assert.equal(trace.at(-2).detail.remainingSeconds,25);
  assert.equal(JSON.stringify(trace).includes(secret),false);
});

function hangingFlow(operation) {
  const disk=new Map(), walletPromises=[]; let authCalls=0, submits=0, sequence=0, verifies=0, requests=0, seconds=now;
  let waitForPoll=async()=>{};let onVerify=()=>{};
  const owner={...wallet,signer:{signAndSendTransactions(){return new Promise((resolve,reject)=>walletPromises.push({resolve,reject}))}}};
  const offers=new Map(); let current=owner;
  const flow=createLiveFinancialFlow({baseUrl:'/api',getWallet:()=>current,nowSeconds:()=>seconds,
    authorize:async()=>{authCalls++;return {token:'private-auth',wallet:owner.address,cluster:'devnet',expiresAt:now+300}},
    requestId:()=>`hanging-${++sequence}`,verifyInstruction:async()=>{verifies++;onVerify()},pollAttempts:2,wait:()=>waitForPoll(),
    storage:{getItem:key=>disk.get(key)??null,setItem:(key,value)=>disk.set(key,value),removeItem:key=>disk.delete(key)},
    fetcher:async(url,init)=>{
      requests++;
      if(url.endsWith('/submit')) {submits++;throw new Error('No late response should be submitted')}
      if(url.includes('/operations/')) {const id=decodeURIComponent(url.split('/operations/')[1].split('?')[0]);return envelope(operation(id,owner))}
      if(url.endsWith('/quotes')) {const q=quote(JSON.parse(init.body),{id:`offer-${sequence}`});offers.set(q.id,q);return envelope({kind:'quote',quote:q})}
      const q=offers.get(JSON.parse(init.body).quoteId);
      const messageBytes=getCompiledTransactionMessageEncoder().encode({version:'legacy',header:{numSignerAccounts:1,numReadonlySignerAccounts:0,numReadonlyNonSignerAccounts:1},staticAccounts:[owner.address,ANTE_UP_PROGRAM_ADDRESS],lifetimeToken:'11111111111111111111111111111111',instructions:[{programAddressIndex:1,accountIndices:[0],data:new Uint8Array()}]});
      return envelope({kind:'transaction',wallet:owner.address,cluster:'devnet',programId:ANTE_UP_PROGRAM_ADDRESS,action:q.intent.action,requestId:q.intent.requestId,quote:q,expiresAt:q.expiresAt,unsignedTransaction:Buffer.from(getTransactionEncoder().encode({messageBytes,signatures:{[owner.address]:null}})).toString('base64')});
    }});
  return {flow,owner,walletPromises,setWait:fn=>{waitForPoll=fn},setTime:value=>{seconds=value},setVerify:fn=>{onVerify=fn},setWallet:value=>{current=value},counts:()=>({authCalls,submits,verifies,requests})};
}
const finalOperation=(id,owner)=>({requestId:id,wallet:owner.address,action:'spotBuy',state:'FINALIZED',signature:`verified-${id}`,error:null});

test('hanging wallet releases on verified status and late response cannot overwrite a newer operation',async()=>{
  const h=hangingFlow(finalOperation);
  const first=await h.flow.quote({action:'spotBuy',marketId,quantityAtoms:'1'});
  const result=await h.flow.execute(first.quote);
  assert.equal(result.state,'FINALIZED');assert.equal(result.signature,'verified-hanging-1');
  assert.equal(h.flow.pending(h.owner),null);assert.equal(h.counts().authCalls,2,'status uses captured session without wallet authentication');
  let release;const gate=new Promise(resolve=>{release=resolve});h.setWait(()=>gate);
  const second=await h.flow.quote({action:'spotBuy',marketId,quantityAtoms:'1'});
  const running=h.flow.execute(second.quote);
  for(let i=0;i<20&&h.walletPromises.length<2;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.walletPromises.length,2);assert.equal(h.flow.pending(h.owner).requestId,'hanging-2');
  h.walletPromises[0].resolve([new Uint8Array(64).fill(1)]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.flow.pending(h.owner).requestId,'hanging-2');assert.equal(h.counts().submits,0);
  release();assert.equal((await running).state,'FINALIZED');
});

test('bounded pending reconciliation retains UNKNOWN on missing signature and permits manual recheck',async()=>{
  let authoritative=false;
  const h=hangingFlow((id,owner)=>({...finalOperation(id,owner),signature:authoritative?'verified-final':null}));
  const offered=await h.flow.quote({action:'spotBuy',marketId,quantityAtoms:'1'});
  assert.equal((await h.flow.execute(offered.quote)).state,'UNKNOWN');assert.ok(h.flow.pending(h.owner));
  assert.equal(h.counts().authCalls,2);
  authoritative=true;assert.equal((await h.flow.recheck()).state,'FINALIZED');assert.equal(h.flow.pending(h.owner),null);
  h.walletPromises[0].reject(new Error('late transport failure'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.flow.pending(h.owner),null);assert.equal(h.counts().submits,0);
});

test('only verified unsigned REQUOTE_REQUIRED failure releases a hanging wallet request',async()=>{
  const h=hangingFlow((id,owner)=>({...finalOperation(id,owner),state:'FAILED',signature:null,error:{code:'REQUOTE_REQUIRED',message:'Verified unlanded expiry'}}));
  const offered=await h.flow.quote({action:'spotBuy',marketId,quantityAtoms:'1'});
  assert.equal((await h.flow.execute(offered.quote)).state,'FAILED');assert.equal(h.flow.pending(h.owner),null);
});


test('verified financial review invokes wallet synchronously on the second tap without auth, HTTP or RPC',async()=>{
  const h=hangingFlow(finalOperation);
  const offer=await h.flow.quote({action:'spotBuy',marketId,quantityAtoms:'1'});
  assert.equal(await h.flow.prepareQuote(offer.quote),null);
  assert.equal(h.walletPromises.length,0);
  const before=h.counts();
  const running=h.flow.signReviewed(offer.quote);
  assert.equal(h.walletPromises.length,1,'signer must start before signReviewed returns its Promise');
  assert.deepEqual(h.counts(),before,'no auth, HTTP or verifier after trusted second tap');
  assert.equal((await h.flow.signReviewed(offer.quote)).state,'UNAVAILABLE');
  assert.equal((await running).state,'FINALIZED');
  assert.equal(h.walletPromises.length,1);
});

test('financial prepared reviews invalidate on expiry, cancellation, quote mutation, new quote and signer change',async()=>{
  for(const reason of ['expiry','cancel','mutation','new-quote','signer-change']) {
    const h=hangingFlow(finalOperation);
    const offer=await h.flow.quote({action:'spotBuy',marketId,quantityAtoms:'1'});
    assert.equal(await h.flow.prepareQuote(offer.quote),null);
    if(reason==='expiry') h.setTime(now+25);
    if(reason==='cancel') h.flow.cancelReview(offer.quote);
    if(reason==='mutation') offer.quote.maxPaymentAtoms='1';
    if(reason==='new-quote') await h.flow.quote({action:'spotBuy',marketId,quantityAtoms:'2'});
    if(reason==='signer-change') h.setWallet({...h.owner,signer:{...h.owner.signer}});
    const result=await h.flow.signReviewed(offer.quote);
    assert.ok(['AWAITING_SIGNATURE','UNAVAILABLE'].includes(result.state),reason);
    assert.equal(h.walletPromises.length,0,reason);
    assert.equal(h.flow.pending(h.owner),null,reason);
  }
});

test('cancelled financial wallet signature clears pending and requires a newly reviewed quote',async()=>{
  const h=hangingFlow(finalOperation);let release;
  h.setWait(()=>new Promise(resolve=>{release=resolve}));
  const offer=await h.flow.quote({action:'spotBuy',marketId,quantityAtoms:'1'});
  assert.equal(await h.flow.prepareQuote(offer.quote),null);
  const running=h.flow.signReviewed(offer.quote);
  h.walletPromises[0].reject(Object.assign(new Error('User rejected'),{code:4001}));
  assert.equal((await running).state,'AWAITING_SIGNATURE');
  assert.equal(h.flow.pending(h.owner),null);
  assert.equal((await h.flow.signReviewed(offer.quote)).state,'UNAVAILABLE');
  release();
});


test('a quote expiring during verification is never exposed as ready to sign',async()=>{
  const h=hangingFlow(finalOperation);
  const offer=await h.flow.quote({action:'spotBuy',marketId,quantityAtoms:'1'});
  h.setVerify(()=>h.setTime(now+25));
  const failed=await h.flow.prepareQuote(offer.quote);
  assert.equal(failed.state,'AWAITING_SIGNATURE');
  assert.match(failed.reason,/expired/);
  await h.flow.signReviewed(offer.quote);
  assert.equal(h.walletPromises.length,0);
  assert.equal(h.flow.pending(h.owner),null);
});
