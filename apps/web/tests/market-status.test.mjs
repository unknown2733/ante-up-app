import test from 'node:test';
import assert from 'node:assert/strict';
import { marketStatusView } from '../src/marketStatus.ts';

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
