import test from 'node:test';
import assert from 'node:assert/strict';
import { marketStatusView, marketActionReason, marketDataNotice } from '../src/marketStatus.ts';

test('indexed market with an aged-out price does not claim data is current', () => {
  const market = { phase: 'INDEXED', dataStatus: 'VALID', price: null };
  assert.deepEqual(marketStatusView(market), { label: 'Index price unavailable', tone: 'red', delayed: true });
});

test('current price, low activity, and explicit outage remain distinct', () => {
  const market = { phase: 'INDEXED', dataStatus: 'VALID', price: { kind: 'indexed', atoms: '1000000', executable: false } };
  assert.deepEqual(marketStatusView(market), { label: 'Data current', tone: 'green', delayed: false });
  assert.deepEqual(marketStatusView({ ...market, dataStatus: 'LOW_ACTIVITY' }), { label: 'Low activity', tone: 'orange', delayed: false });
  assert.deepEqual(marketStatusView({ ...market, dataStatus: 'OUTAGE' }), { label: 'Data unavailable', tone: 'red', delayed: false });
});

test('storage, publication, RPC and normal LP closure explain different conditions without enabling actions',()=>{
 const market={phase:'INDEXED',dataStatus:'VALID',price:null,priceReadiness:{state:'STALE',dataThrough:100,checkedAt:800,reason:'DATA_STALE'},capabilities:{openFree:{allowed:false,reason:'ENTRY_PAUSED'},spotBuy:{allowed:false,reason:'DATA_NOT_READY'},depositLP:{allowed:false,reason:'LP_WINDOW_CLOSED'},claim:{allowed:true,reason:null}}};
 assert.match(marketDataNotice(market),/observation is delayed/);
 for(const [reason,text] of [['STORAGE_PRESSURE',/storage/],['PUBLICATION_PENDING',/chain verification/],['RPC_RATE_LIMITED',/connection is busy/]]){
  const blocked={...market,runtimeStatus:{reason,checkedAt:800}};
  assert.match(marketDataNotice(blocked),text);
  assert.match(marketActionReason(blocked,'spotBuy'),text);
  assert.equal(marketActionReason(blocked,'claim'),null);
  assert.match(marketActionReason(blocked,'depositLP'),/weekly liquidity window/);
  assert.equal(blocked.capabilities.spotBuy.allowed,false);
 }
 assert.match(marketActionReason({...market,runtimeStatus:{reason:'STORAGE_PRESSURE',checkedAt:800}},'openFree'),/Existing chips can still be taken back/);
 assert.equal(marketStatusView({phase:'CURVE',dataStatus:'VALID',price:{kind:'curve',atoms:'1000000',executable:true}}).label,'Observed data');
});
