import assert from 'node:assert/strict';
import test from 'node:test';
import { createObservedReferenceReadApi } from './observedReference.ts';

test('new measured count refreshes the public catalog and chart without enabling trades', async () => {
  const capturedAtMs = Date.now() - 1000;
  const observation = { slug: 'youtube-S0Q4gqBUs7c', kind: 'YOUTUBE_VIEWS', aggregation: 'cumulative',
    value: '14200000', observedAtMs: capturedAtMs, capturedAtMs, reportedDate: null,
    provider: 'YouTube', sourceUrl: 'https://www.youtube.com/watch?v=S0Q4gqBUs7c', rawSha256: 'a'.repeat(64) };
  let current = observation;
  const fetcher = async url => new Response(JSON.stringify({ schemaVersion: '0.1', mode: 'devnet', asOf: Math.floor(Date.now() / 1000), data: [current] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  const api = createObservedReferenceReadApi('https://example.test', fetcher);
  const id = `reference:market:${observation.slug}`;
  const initial = (await api.listMarkets()).find(market => market.id === id);
  assert.equal(initial.activity.value, observation.value);
  assert.equal(initial.phase, 'PREVIEW');
  assert.equal(initial.latestPrice, null);
  assert.equal(initial.liveMarketId, undefined);
  const history = await api.getHistory(id, 'ALL');
  assert.equal(history.series.length, 1, 'measured refresh replaces generated chart preview');
  assert.equal(history.series[0].points.at(-1).value, observation.value);
  assert.equal(history.series[0].points.at(-1).observationId, `public:${observation.rawSha256}:${capturedAtMs}`);
  assert.deepEqual(history.actions, []);
  current = { ...observation, value: '14200100', observedAtMs: capturedAtMs + 500,
    capturedAtMs: capturedAtMs + 500, rawSha256: 'b'.repeat(64) };
  assert.equal((await api.listMarkets()).find(market => market.id === id).activity.value, '14200100');
  assert.equal((await api.getHistory(id, 'ALL')).series[0].points.at(-1).value, '14200100');
});

test('reference API outage preserves the dated baseline instead of inventing an update', async () => {
  const api = createObservedReferenceReadApi('https://example.test', async () => new Response(null, { status: 503 }));
  const market = (await api.listMarkets()).find(item => item.id === 'reference:market:youtube-S0Q4gqBUs7c');
  assert.equal(market.activity.value, '14169301');
  const history = await api.getHistory(market.id, 'ALL');
  assert.equal(history.series[0].points[0].value, '14169301');
  assert.match(market.source.label, /captured 2026-10-12/);
});
