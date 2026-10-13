import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { address, getBase58Decoder, getBase64Decoder, getCompiledTransactionMessageEncoder, getTransactionEncoder } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS, findAdmissionPda, findRecordPda, findWalletMarketPda, findWalletStatsPda, getCloseFreeInstructionDataEncoder, getOpenFreeInstructionDataEncoder } from '@ante-up/chain-client';

const server = await createServer({ optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => server.close());
const { createLiveFreeFlow } = await server.ssrLoadModule('/src/liveFree.ts');
const { createApiClock } = await server.ssrLoadModule('/src/apiClock.ts');
const owner = address('Vote111111111111111111111111111111111111111');
const marketAddress = address('Stake11111111111111111111111111111111111111');
const programId = ANTE_UP_PROGRAM_ADDRESS;
const system = address('11111111111111111111111111111111');
const [admission] = await findAdmissionPda();
const [walletStats] = await findWalletStatsPda({ owner });
const [walletMarket] = await findWalletMarketPda({ owner, market: marketAddress });
const [recordId] = await findRecordPda({ owner, market: marketAddress, recordId: 7n });
const now = 1_700_000_000;
const signatureBytes = new Uint8Array(64).fill(1);
const signature = getBase58Decoder().decode(signatureBytes);
const market = { id: marketAddress, chain: { cluster: 'devnet', programId, address: marketAddress }, capabilities: { openFree: { allowed: true, reason: null }, closeFree: { allowed: true, reason: null } } };

function unsignedTransaction(action) {
  const opening = action === 'openFree';
  const staticAccounts = opening
    ? [owner, admission, walletStats, walletMarket, recordId, marketAddress, system, programId]
    : [owner, recordId, walletStats, walletMarket, marketAddress, programId];
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    version: 'legacy',
    header: { numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: opening ? 3 : 2 },
    staticAccounts,
    lifetimeToken: '11111111111111111111111111111111',
    instructions: [{ programAddressIndex: opening ? 7 : 5, accountIndices: opening ? [5, 1, 2, 3, 4, 0, 6] : [4, 1, 2, 3, 0], data: opening ? getOpenFreeInstructionDataEncoder().encode({ recordId: 7n }) : getCloseFreeInstructionDataEncoder().encode({}) }],
  });
  return getBase64Decoder().decode(getTransactionEncoder().encode({ messageBytes, signatures: { [owner]: null } }));
}
function setup({ prepareResult, signAndSend, signMessage, submitFails = false, operationState = 'FINALIZED', canSignMessage = true, challengeMessage, clock } = {}) {
  const calls = [];
  let current;
  let nonce = 0;
  let requestNumber = 0;
  const operations = new Map();
  const signer = { address: owner, async signAndSendTransactions(transactions) { calls.push(['signAndSend', transactions.length]); return signAndSend ? signAndSend(transactions) : [signatureBytes]; } };
  const wallet = { address: owner, cluster: 'devnet', supportedTransactionVersions: new Set(['legacy']), signer };
  current = wallet;
  const envelope = (data, mode = 'devnet') => new Response(JSON.stringify({ schemaVersion: '0.1', mode, asOf: now, data, nextCursor: null }), { headers: { 'content-type': 'application/json' } });
  const fetcher = async (url, init) => {
    const path = new URL(url, 'http://example').pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push([init.method, path, body, init.headers?.Authorization ?? null]);
    if (path === '/api/v1/auth') {
      nonce++;
      const text = `Ante Up API v1\ncluster:devnet\nwallet:${owner}\nnonce:nonce-${nonce}\nexpiresAt:${now + 300}`;
      return envelope({ nonce: `nonce-${nonce}`, expiresAt: now + 300, message: challengeMessage ?? text });
    }
    if (path === '/api/v1/auth/session') {
      assert.equal(body.wallet, owner);
      assert.equal(body.cluster, 'devnet');
      assert.equal(body.signature, getBase64Decoder().decode(new Uint8Array(64).fill(2)));
      return envelope({ token: 'opaque-session-token', wallet: owner, cluster: 'devnet', expiresAt: now + 800 });
    }
    assert.equal(init.headers?.Authorization, 'Bearer opaque-session-token');
    if (path === '/api/v1/transactions/prepare') {
      assert.equal(body.wallet, owner);
      assert.equal(body.marketId, marketAddress);
      assert.equal(body.recordId, body.action === 'closeFree' ? recordId : null);
      return envelope(prepareResult ?? { kind: 'transaction', action: body.action, requestId: body.requestId, wallet: owner, cluster: 'devnet', programId, recordId, expiresAt: now + 20, unsignedTransaction: unsignedTransaction(body.action), lastValidBlockHeight: '10', quoteRef: null });
    }
    const submit = path.match(/^\/api\/v1\/operations\/([^/]+)\/submit$/);
    if (submit) {
      if (submitFails) throw new Error('submit response lost');
      assert.equal(body.wallet, owner);
      assert.equal(body.signature, signature);
      const operation = { requestId: submit[1], wallet: owner, action: requestNumber === 1 ? 'openFree' : 'closeFree', signature, state: 'SUBMITTED', error: null };
      operations.set(submit[1], operation);
      return envelope(operation);
    }
    const read = path.match(/^\/api\/v1\/operations\/([^/]+)$/);
    if (read) {
      const operation = operations.get(read[1]) ?? { requestId: read[1], wallet: owner, action: 'openFree', signature, state: 'SUBMITTED', error: null };
      return envelope({ ...operation, state: operationState });
    }
    throw new Error(`Unexpected route ${path}`);
  };
  const flow = createLiveFreeFlow({
    baseUrl: '/api', fetcher, getWallet: () => current,
    canSignMessage: () => canSignMessage,
    signMessage: async (bytes) => { calls.push(['signMessage', new TextDecoder().decode(bytes)]); return signMessage ? signMessage(bytes) : new Uint8Array(64).fill(2); },
    nowSeconds: clock?.nowSeconds ?? (() => now), onServerTime:clock?.observe,
    requestId: () => `00000000-0000-4000-8000-${String(++requestNumber).padStart(12, '0')}`,
    wait: async () => {}, pollAttempts: 2,
  });
  return { flow, calls, wallet, setWallet(value) { current = value; }, operations };
}

test('device clock ahead or behind does not reject a fresh API challenge or transaction', async () => {
  for(const skew of [-3600,3600]){
    const clock=createApiClock(()=>performance.now(),()=> (now+skew)*1000);
    const {flow}=setup({clock});
    assert.equal((await flow.run({market,action:'openFree',recordId:null})).state,'FINALIZED');
  }
});

test('review finishes authentication and preparation without opening the transaction wallet; second explicit step sends once', async () => {
  const {flow,calls}=setup();
  const result=await flow.prepare({market,action:'openFree',recordId:null});
  assert.equal(result.state,'PREPARED');
  assert.equal(calls.filter(call=>call[0]==='signMessage').length,1);
  assert.equal(calls.filter(call=>call[1]==='/api/v1/transactions/prepare').length,1);
  assert.equal(calls.filter(call=>call[0]==='signAndSend').length,0);
  const count=calls.length;
  const signed=flow.signReviewed(result.review);
  const duplicate=await flow.signReviewed(result.review);
  assert.equal(duplicate.state,'AWAITING_SIGNATURE');
  assert.equal((await signed).state,'FINALIZED');
  assert.equal(calls[count][0],'signAndSend','no auth or prepare HTTP call precedes the second wallet intent');
  assert.equal(calls.filter(call=>call[0]==='signAndSend').length,1);
});

test('cancelled, expired, forged, superseded and wallet-changed reviews cannot send', async () => {
  for(const kind of ['cancelled','expired','forged','superseded','wallet-changed']) {
    let seconds=now;
    const {flow,calls,setWallet}=setup({clock:{nowSeconds:()=>seconds}});
    const result=await flow.prepare({market,action:'openFree',recordId:null});
    assert.equal(result.state,'PREPARED');
    if(kind==='cancelled') flow.cancelReview(result.review);
    if(kind==='expired') seconds=now+20;
    if(kind==='superseded') await flow.prepare({market,action:'openFree',recordId:null});
    if(kind==='wallet-changed') setWallet(null);
    const signed=await flow.signReviewed(kind==='forged'?{...result.review}:result.review);
    assert.equal(signed.state,'AWAITING_SIGNATURE',kind);
    assert.equal(calls.filter(call=>call[0]==='signAndSend').length,0,kind);
  }
});

test('two-step signing retains wire validation and ambiguous-send recovery without resending', async () => {
  const malformed=setup({prepareResult:{kind:'transaction',action:'openFree',requestId:'00000000-0000-4000-8000-000000000001',wallet:owner,cluster:'devnet',programId,recordId,expiresAt:now+20,unsignedTransaction:'AAAA',lastValidBlockHeight:'10',quoteRef:null}});
  const bad=await malformed.flow.prepare({market,action:'openFree',recordId:null});
  assert.equal(bad.state,'PREPARED');
  assert.equal((await malformed.flow.signReviewed(bad.review)).state,'AWAITING_SIGNATURE');
  assert.equal(malformed.calls.filter(call=>call[0]==='signAndSend').length,0);
  const {flow,calls,wallet}=setup({signAndSend:async()=>{throw new Error('transport disconnected');}});
  const request={market,action:'openFree',recordId:null};
  const ready=await flow.prepare(request);
  const unknown=await flow.signReviewed(ready.review);
  assert.equal(unknown.state,'UNKNOWN');
  assert.equal(flow.pending(request,wallet).requestId,unknown.requestId);
  assert.equal((await flow.prepare(request)).state,'UNKNOWN');
  assert.equal((await flow.recheck(request,unknown.requestId,null)).state,'FINALIZED');
  assert.equal(calls.filter(call=>call[0]==='signAndSend').length,1);
});

test('API clock advances without wall time and stale observations cannot extend expiry', () => {
  let tick=0,wall=1;
  const clock=createApiClock(()=>tick,()=>wall);
  clock.observe(now,0);
  tick=31_000; wall=0;
  assert.equal(clock.nowSeconds(),now+31);
  clock.observe(now-100,30_000);
  assert.equal(clock.nowSeconds(),now+31);
  tick=32_000;
  assert.equal(clock.nowSeconds(),now+32);
  assert.throws(()=>clock.observe(NaN,0),/Invalid API clock/);
});

test('explicit Phantom cancellation permits a user-initiated retry without an uncertain request', async () => {
  const { flow, calls, wallet } = setup({ signAndSend: async () => { throw Object.assign(new Error('User rejected'), {code:4001}); } });
  const request = {market, action:'closeFree', recordId};
  assert.equal((await flow.run(request)).state, 'AWAITING_SIGNATURE');
  assert.equal(flow.pending(request,wallet), null);
  assert.equal(calls.filter(call=>call[0]==='signAndSend').length,1);
  assert.equal((await flow.run(request)).state, 'AWAITING_SIGNATURE');
  assert.equal(calls.filter(call=>call[0]==='signAndSend').length,2);
  assert.equal(calls.filter(call=>typeof call[1]==='string' && call[1].endsWith('/submit')).length,0);
});

test('session signs exact challenge once, prepares both actions, reports once, and waits for finalized operation', async () => {
  const { flow, calls, wallet } = setup();
  const stages = [];
  const opened = await flow.run({ market, action: 'openFree', recordId: null }, (stage) => stages.push(stage));
  assert.equal(opened.state, 'FINALIZED');
  assert.equal(opened.signature, signature);
  flow.observeProfile(marketAddress, wallet, { wallet: owner, openRecords: [{id:recordId,wallet:owner,marketId:marketAddress,status:'OPEN',finality:'finalized'}], closedRecords:[] });
  const closed = await flow.run({ market, action: 'closeFree', recordId });
  assert.equal(closed.state, 'FINALIZED');
  assert.equal(calls.filter((call) => call[1] === '/api/v1/auth').length, 1);
  assert.equal(calls.filter((call) => call[1] === '/api/v1/auth/session').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'signMessage').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'signAndSend').length, 2);
  assert.equal(calls.filter((call) => typeof call[1] === 'string' && call[1].endsWith('/submit')).length, 2);
  assert.ok(stages.includes('SUBMITTED'));
});

test('finalized open blocks another preparation while indexed profile is stale, then allows close', async () => {
  const {flow,calls,wallet} = setup();
  const request = {market,action:'openFree',recordId:null};
  assert.equal((await flow.run(request)).state,'FINALIZED');
  assert.equal((await flow.run(request)).state,'UNAVAILABLE');
  assert.equal(calls.filter(call=>call[1]==='/api/v1/transactions/prepare').length,1);
  assert.equal(flow.observeProfile(marketAddress,wallet,{wallet:owner,openRecords:[],closedRecords:[]}),false);
  assert.notEqual(flow.projectionPending(marketAddress,wallet),null);
  assert.equal(flow.observeProfile(marketAddress,wallet,{wallet:owner,openRecords:[{id:recordId,wallet:owner,marketId:marketAddress,status:'OPEN',finality:'finalized'}],closedRecords:[]}),true);
  assert.equal((await flow.run({market,action:'closeFree',recordId})).state,'FINALIZED');
  assert.equal((await flow.run({market,action:'closeFree',recordId})).state,'UNAVAILABLE');
  assert.equal(calls.filter(call=>call[1]==='/api/v1/transactions/prepare').length,2);
});

test('unsupported wallet, disabled market, mismatched challenge, and notExecutable preparation never send', async () => {
  const unsupported = setup({ canSignMessage: false });
  assert.match(unsupported.flow.supportReason({ market, action: 'openFree', recordId: null }, unsupported.wallet), /sign an API authentication message/);
  assert.equal((await unsupported.flow.run({ market, action: 'openFree', recordId: null })).state, 'UNAVAILABLE');
  assert.equal(unsupported.calls.length, 0);
  const disabled = setup();
  assert.equal((await disabled.flow.run({ market: { ...market, capabilities: { openFree: { allowed: false, reason: 'LIMIT_REACHED' } } }, action: 'openFree', recordId: null })).state, 'UNAVAILABLE');
  assert.equal(disabled.calls.length, 0);
  const tampered = setup({ challengeMessage: 'sign me anything' });
  assert.equal((await tampered.flow.run({ market, action: 'openFree', recordId: null })).state, 'AWAITING_SIGNATURE');
  assert.equal(tampered.calls.filter((call) => call[0] === 'signMessage').length, 0);
  const unavailable = setup({ prepareResult: { kind: 'notExecutable', reason: 'CHAIN_ADAPTER_NOT_CONFIGURED' } });
  const result = await unavailable.flow.run({ market, action: 'openFree', recordId: null });
  assert.equal(result.state, 'UNAVAILABLE');
  assert.equal(unavailable.calls.filter((call) => call[0] === 'signAndSend').length, 0);
  const stale = setup({ prepareResult: { kind: 'transaction', action: 'openFree', requestId: '00000000-0000-4000-8000-000000000001', wallet: owner, cluster: 'devnet', programId, recordId, expiresAt: now + 31, unsignedTransaction: unsignedTransaction('openFree'), lastValidBlockHeight: '10', quoteRef: null } });
  assert.equal((await stale.flow.run({ market, action: 'openFree', recordId: null })).state, 'AWAITING_SIGNATURE');
  assert.equal(stale.calls.filter((call) => call[0] === 'signAndSend').length, 0);
});

test('ambiguous wallet send blocks repeat and permits request-ID recheck without resending', async () => {
  const { flow, calls } = setup({ signAndSend: async () => { throw new Error('wallet response lost'); } });
  const first = await flow.run({ market, action: 'openFree', recordId: null });
  assert.equal(first.state, 'UNKNOWN');
  assert.equal(first.signature, null);
  assert.equal(flow.pending({ market, action: 'openFree', recordId: null }, { address: owner, cluster: 'devnet' })?.requestId, first.requestId);
  const again = await flow.run({ market, action: 'openFree', recordId: null });
  assert.equal(again.state, 'UNKNOWN');
  assert.equal(again.requestId, first.requestId);
  assert.equal(calls.filter((call) => call[0] === 'signAndSend').length, 1);
  const checked = await flow.recheck({ market, action: 'openFree', recordId: null }, first.requestId, null);
  assert.equal(checked.state, 'FINALIZED');
  assert.equal(checked.signature, signature);
  assert.equal(calls.filter((call) => call[0] === 'signAndSend').length, 1);
});

test('lost submission response keeps known signature and rechecks without submitting twice', async () => {
  const { flow, calls } = setup({ submitFails: true });
  const first = await flow.run({ market, action: 'openFree', recordId: null });
  assert.equal(first.state, 'UNKNOWN');
  assert.equal(first.signature, signature);
  const again = await flow.run({ market, action: 'openFree', recordId: null });
  assert.equal(again.requestId, first.requestId);
  assert.equal(calls.filter((call) => typeof call[1] === 'string' && call[1].endsWith('/submit')).length, 1);
  const checked = await flow.recheck({ market, action: 'openFree', recordId: null }, first.requestId, signature);
  assert.equal(checked.state, 'FINALIZED');
  assert.equal(calls.filter((call) => call[0] === 'signAndSend').length, 1);
});

test('duplicate click during wallet authentication does not prepare or sign twice', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { flow, calls } = setup({ signMessage: async () => { await gate; return new Uint8Array(64).fill(2); } });
  const first = flow.run({ market, action: 'openFree', recordId: null });
  const duplicate = await flow.run({ market, action: 'openFree', recordId: null });
  assert.equal(duplicate.state, 'BUSY');
  release();
  assert.equal((await first).state, 'FINALIZED');
  assert.equal(calls.filter((call) => call[0] === 'signAndSend').length, 1);
});

test('wallet change after message signature cancels before prepare and discards session', async () => {
  const setupValue = setup();
  let current = setupValue.wallet;
  // Trigger a different account during the asynchronous challenge request.
  const changed = createLiveFreeFlow({
    baseUrl: '/api', getWallet: () => current,
    canSignMessage: () => true,
    signMessage: async () => { current = null; return new Uint8Array(64).fill(2); },
    fetcher: async (url, init) => {
      const path = new URL(url, 'http://example').pathname;
      assert.equal(path, '/api/v1/auth');
      const message = `Ante Up API v1\ncluster:devnet\nwallet:${owner}\nnonce:nonce-1\nexpiresAt:${now + 300}`;
      return new Response(JSON.stringify({ schemaVersion: '0.1', mode: 'devnet', asOf: now, data: { nonce: 'nonce-1', expiresAt: now + 300, message }, nextCursor: null }));
    },
    nowSeconds: () => now, requestId: () => '00000000-0000-4000-8000-000000000001',
  });
  const result = await changed.run({ market, action: 'openFree', recordId: null });
  assert.equal(result.state, 'AWAITING_SIGNATURE');
  assert.match(result.reason, /Wallet or cluster changed/);
});


test('parallel private reads share one authentication challenge and message signature', async () => {
  let finishSignature;
  const gate = new Promise(resolve => { finishSignature = resolve; });
  const { flow, calls, wallet } = setup({ signMessage: () => gate });
  const first = flow.authorize(wallet);
  const second = flow.authorize({ ...wallet });
  assert.equal(first, second, 'same identity shares the actual in-flight promise');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call[1] === '/api/v1/auth').length, 1);
  assert.equal(calls.filter(call => call[0] === 'signMessage').length, 1);
  finishSignature(new Uint8Array(64).fill(2));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  await flow.authorize(wallet);
  assert.equal(calls.filter(call => call[1] === '/api/v1/auth/session').length, 1);
});

test('shared authentication rejection releases the in-flight state for a fresh retry', async () => {
  let attempts = 0;
  const { flow, calls, wallet } = setup({ signMessage: async () => {
    if (++attempts === 1) throw new Error('Wallet approval rejected');
    return new Uint8Array(64).fill(2);
  } });
  const results = await Promise.allSettled([flow.authorize(wallet), flow.authorize(wallet)]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(attempts, 1);
  await flow.authorize(wallet);
  assert.equal(attempts, 2);
  assert.equal(calls.filter(call => call[1] === '/api/v1/auth/session').length, 1);
});

test('signer change and explicit invalidation reject stale authorization without clearing its replacement', async () => {
  for (const replaceSigner of [true, false]) {
    let finishOld;
    let attempts = 0;
    const gate = new Promise(resolve => { finishOld = resolve; });
    const { flow, calls, wallet, setWallet } = setup({ signMessage: () => ++attempts === 1 ? gate : Promise.resolve(new Uint8Array(64).fill(2)) });
    const first = flow.authorize(wallet);
    const stale = assert.rejects(first, /authentication changed/);
    await new Promise(resolve => setImmediate(resolve));
    const nextWallet = replaceSigner ? { ...wallet, signer: { ...wallet.signer } } : wallet;
    if (replaceSigner) setWallet(nextWallet); else flow.clearSession();
    const current = await flow.authorize(nextWallet);
    finishOld(new Uint8Array(64).fill(2));
    await stale;
    assert.equal(await flow.authorize(nextWallet), current);
    assert.equal(attempts, 2);
    assert.equal(calls.filter(call => call[1] === '/api/v1/auth/session').length, 1, 'stale auth is stopped before submitting a session');
  }
});

test('a cached API session is not reused after signer identity changes', async () => {
  const { flow, calls, wallet, setWallet } = setup();
  await flow.authorize(wallet);
  const nextWallet = { ...wallet, signer: { ...wallet.signer } };
  setWallet(nextWallet);
  await flow.authorize(nextWallet);
  assert.equal(calls.filter(call => call[0] === 'signMessage').length, 2);
});
