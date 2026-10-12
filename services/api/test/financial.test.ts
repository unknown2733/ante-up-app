import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { validateFinancialIntent, validateFinancialPortfolio, validateFinancialQuote } from '../src/financial.ts';
import { LiveStore } from '../src/live-store.ts';
import type { FinancialQuote } from '../../../contracts/financial.ts';
import type { MarketView } from '../../../contracts/types.ts';

const wallet = '11111111111111111111111111111111';
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const at = 1_800_000_000;
const intent = {requestId,wallet,action:'openPro',marketId:wallet,collateralAtoms:'100000000',leverageBps:'50000',direction:'short'} as const;

test('financial intent rejects missing amounts, noncanonical units, and extra mutable fields', () => {
  assert.deepEqual(validateFinancialIntent(intent),intent);
  assert.throws(() => validateFinancialIntent({...intent,collateralAtoms:'1.0'}),/canonical atoms/);
  assert.throws(() => validateFinancialIntent({...intent,leverageBps:'50001'}),/out of range/);
  assert.throws(() => validateFinancialIntent({...intent,maxPaymentAtoms:'1'}),/unexpected financial field/);
  assert.throws(() => validateFinancialIntent({...intent,action:'graduate'}),/invalid/);
  assert.deepEqual(validateFinancialIntent({requestId,wallet,action:'faucet',marketId:null}),{requestId,wallet,action:'faucet',marketId:null});
});

test('financial portfolio rejects owner and finality mismatch', () => {
  const value: any = {wallet,quoteMint:wallet,quoteBalanceAtoms:'0',tokenBalances:[],positions:[],claims:[],lpShares:[]};
  assert.deepEqual(validateFinancialPortfolio({value,slot:'1',cluster:'localnet',programId:wallet,finality:'finalized'},{wallet,cluster:'localnet',programId:wallet}),value);
  assert.throws(() => validateFinancialPortfolio({value:{...value,wallet:'other'},slot:'1',cluster:'localnet',programId:wallet,finality:'finalized'},{wallet,cluster:'localnet',programId:wallet}),/DATA_NOT_READY/);
});

test('financial quote binds immutable intent, common snapshot, and open cutoff', () => {
  const market: MarketView = {id:wallet,keyword:'x',aliases:[],phase:'INDEXED',epochPhase:'PRO_OPEN',dataStatus:'VALID',supported:true,
    chain:{cluster:'localnet',programId:wallet,address:wallet},anchor:null,price:{kind:'indexed',atoms:'10',executable:true},capabilities:{},
    snapshot:{payload:{schemaVersion:'0.1',formulaVersion:'h3-d7-q12-v1',configVersion:'1',queryVersion:'1',queryHash:'a'.repeat(64),admission:{state:'OPEN',recoveryCount:2,reason:null},marketId:wallet,sequence:'2',dataThrough:at-10,computedAt:at-5,activityNowQ12:'1',activity7dQ12:'1',dataStatus:'VALID',reason:null,evidenceHash:'a'.repeat(64)},payloadHash:'b'.repeat(64),chain:{cluster:'localnet',programId:wallet,address:wallet},signature:'sig',slot:'1',publishedAt:at-3,finality:'finalized'}};
  const quote: FinancialQuote = {id:requestId,intent:validateFinancialIntent(intent),chain:market.chain!,phase:'INDEXED',quotedAt:at,expiresAt:at+30,
    configVersion:'1',stateVersion:'2',snapshot:{marketId:wallet,sequence:'2',payloadHash:'b'.repeat(64)},priceAtoms:'10',grossAtoms:'100',tradeFeeAtoms:'1',timePrepaidAtoms:'1',maxPaymentAtoms:'102',minReceiveAtoms:'0',maxPayoutAtoms:'600',maturityAt:at+100_800,executable:true};
  // Pick a Monday UTC maturity after the test clock.
  quote.maturityAt = at + ((345600 - at % 604800 + 604800) % 604800);
  assert.equal(validateFinancialQuote(quote,quote.intent,market,{cluster:'localnet',programId:wallet,now:at}),quote);
  assert.equal(validateFinancialQuote({...quote,intent:{direction:'short',leverageBps:'50000',collateralAtoms:'100000000',marketId:wallet,action:'openPro',wallet,requestId}},quote.intent,market,{cluster:'localnet',programId:wallet,now:at}).id,quote.id);
  assert.throws(() => validateFinancialQuote({...quote,intent:{...quote.intent,collateralAtoms:'1'}},quote.intent,market,{cluster:'localnet',programId:wallet,now:at}),/REQUOTE_REQUIRED/);
  assert.throws(() => validateFinancialQuote({...quote,snapshot:{...quote.snapshot!,sequence:'3'}},quote.intent,market,{cluster:'localnet',programId:wallet,now:at}),/DATA_NOT_READY/);
  assert.throws(() => validateFinancialQuote({...quote,expiresAt:at+31},quote.intent,market,{cluster:'localnet',programId:wallet,now:at}),/REQUOTE_REQUIRED/);
  const exitMarket={...market,dataStatus:'LOW_ACTIVITY' as const,price:{kind:'indexed' as const,atoms:'10',executable:false}};
  const exitIntent=validateFinancialIntent({requestId,wallet,action:'closePro',marketId:wallet,positionId:'position'});
  assert.equal(validateFinancialQuote({...quote,intent:exitIntent,maturityAt:null},exitIntent,exitMarket,{cluster:'localnet',programId:wallet,now:at}).intent.action,'closePro');
  const claimIntent=validateFinancialIntent({requestId,wallet,action:'claim',marketId:wallet,claimId:'claim'});
  const outageMarket={...market,dataStatus:'OUTAGE' as const,snapshot:null,price:null};
  assert.equal(validateFinancialQuote({...quote,intent:claimIntent,snapshot:null,phase:'CURVE',maturityAt:null},claimIntent,outageMarket,{cluster:'localnet',programId:wallet,now:at}).intent.action,'claim');
  const curveMarket={...outageMarket,phase:'CURVE' as const,epochPhase:null};
  for (const action of ['curveBuy','curveSell'] as const) {
    const curveIntent=validateFinancialIntent({requestId,wallet,action,marketId:wallet,quantityAtoms:'10'});
    const curveQuote={...quote,intent:curveIntent,snapshot:null,phase:'CURVE' as const,priceAtoms:'101',maturityAt:null};
    assert.equal(validateFinancialQuote(curveQuote,curveIntent,curveMarket,{cluster:'localnet',programId:wallet,now:at}).intent.action,action);
  }
  const indexedIntent=validateFinancialIntent({requestId,wallet,action:'spotBuy',marketId:wallet,quantityAtoms:'10'});
  assert.throws(()=>validateFinancialQuote({...quote,intent:indexedIntent,snapshot:null,maturityAt:null},indexedIntent,outageMarket,{cluster:'localnet',programId:wallet,now:at}),/DATA_NOT_READY/);
});

test('financial endpoints require owner and stay closed without a chain adapter', async () => {
  const api = createApp({now:()=>at,verifier:{async verify(){return true;}}});
  const uri='http://fixture.test';
  const unauth=await api.handle(new Request(`${uri}/v1/financial/portfolio?wallet=${wallet}`));
  assert.equal(unauth.status,403);
  const challenge=await (await api.handle(new Request(`${uri}/v1/auth`,{method:'POST',body:JSON.stringify({wallet,cluster:'localnet'})}))).json() as any;
  const headers={'x-ante-nonce':challenge.data.nonce,'x-ante-signature':'test'};
  const portfolio=await api.handle(new Request(`${uri}/v1/financial/portfolio?wallet=${wallet}`,{headers}));
  assert.equal(portfolio.status,409);
  const next=await (await api.handle(new Request(`${uri}/v1/auth`,{method:'POST',body:JSON.stringify({wallet,cluster:'localnet'})}))).json() as any;
  const quote=await (await api.handle(new Request(`${uri}/v1/financial/quotes`,{method:'POST',headers:{'x-ante-nonce':next.data.nonce,'x-ante-signature':'test'},body:JSON.stringify({requestId,wallet,action:'faucet',marketId:null})}))).json() as any;
  assert.equal(quote.data.kind,'notExecutable');
});

test('stored financial quote preserves request identity in SQLite', () => {
  const store = new LiveStore(':memory:');
  const q: FinancialQuote = {id:requestId,intent:validateFinancialIntent({requestId,wallet,action:'faucet',marketId:null}),chain:{cluster:'localnet',programId:wallet,address:wallet},phase:null,quotedAt:at,expiresAt:at+30,configVersion:'1',snapshot:null,stateVersion:'1',priceAtoms:'0',grossAtoms:'0',tradeFeeAtoms:'0',timePrepaidAtoms:'0',maxPaymentAtoms:'0',minReceiveAtoms:'1000000000',maxPayoutAtoms:null,maturityAt:null,executable:true};
  store.saveFinancialQuote(q,'localnet',wallet);
  assert.deepEqual(store.getFinancialQuote(requestId),q);
  assert.equal(store.saveFinancialQuote({...q,intent:{action:'faucet',marketId:null,wallet,requestId}},'localnet',wallet).id,q.id);
  assert.throws(() => store.saveFinancialQuote({...q,intent:{...q.intent,wallet:'other'}},'localnet',wallet),/ALREADY_EXECUTED/);
  store.close();
});
