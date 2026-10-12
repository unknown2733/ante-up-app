import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReadonlyMock } from '../../apps/web/qa/consumer/readonly-mock-api.mjs';

const get = path => handleReadonlyMock(new Request('http://qa.local' + path));

test('local QA API serves real fixture envelopes and isolated Demo DTOs', async () => {
  const legacy = await (await get('/v1/markets')).json();
  assert.equal(legacy.schemaVersion, '0.1');
  assert.equal(legacy.mode, 'fixture');
  assert.equal(legacy.data[0].chain, null);
  const demo = await (await get('/v1/consumer/markets?mode=DEMO')).json();
  assert.ok(demo.data.length >= 10);
  assert.ok(demo.data.every(market => market.source.mode === 'DEMO'));
  const id = encodeURIComponent(demo.data[0].id);
  const history = await (await get(`/v1/consumer/markets/${id}/history?period=1D&mode=DEMO`)).json();
  assert.equal(history.data.source.mode, 'DEMO');
  assert.ok(history.data.series.some(series => series.points.length >= 24));
  const emptyLive = await (await get('/v1/consumer/markets')).json();
  assert.equal(emptyLive.mode, 'devnet');
  assert.deepEqual(emptyLive.data, []);
  const isolated = await (await get(`/v1/consumer/markets/${id}/history?period=1D`)).json();
  assert.equal(isolated.mode, 'devnet');
  assert.equal(isolated.data, null);
  const emptyHistory = await (await get('/v1/consumer/markets/devnet:missing/history?period=ALL')).json();
  assert.equal(emptyHistory.data, null);
  const legacyHistory = await (await get('/v1/consumer/markets/fixture%3Asol/history?period=ALL')).json();
  assert.equal(legacyHistory.mode, 'devnet');
  assert.equal(legacyHistory.data.market.liveMarketId, 'fixture:sol');
  assert.deepEqual(legacyHistory.data.series, []);
  assert.deepEqual(legacyHistory.data.actions, []);
  const board = await (await get('/v1/consumer/leaderboard?period=ALL&mode=DEMO')).json();
  assert.equal(board.data.source.mode, 'DEMO');
});

test('mock rejects writes, including note and faucet requests, without executing them', async () => {
  for (const path of ['/v1/consumer/notes/demo:action:x', '/v1/faucet/claims', '/v1/transactions/prepare']) {
    const response = await handleReadonlyMock(new Request('http://qa.local' + path, { method: 'POST' }));
    assert.equal(response.status, 405);
    assert.equal((await response.json()).code, 'UNAUTHORIZED');
  }
});
