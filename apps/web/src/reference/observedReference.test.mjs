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
  assert.equal(history.series.length, 2, 'a sparse measured history retains a separate illustrative preview');
  assert.equal(history.series[0].points.at(-1).value, observation.value);
  assert.equal(history.series[1].evidence, 'ILLUSTRATIVE');
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

test('older provider report dates are fetched and shown beside a separate sparse preview', async () => {
  const observation = { slug: 'spotify-5MhMXTuVODDF234VDvSxQx', kind: 'SPOTIFY_STREAMS',
    aggregation: 'cumulative', value: '113536955', observedAtMs: Date.parse('2026-10-13T00:00:00Z'),
    capturedAtMs: Date.parse('2026-10-23T00:00:00Z'), reportedDate: '2026-10-13',
    provider: 'Kworb', sourceUrl: 'https://kworb.net/spotify/artist/5oOhM2DFWab8XhSdQiITry_songs.html',
    rawSha256: 'c'.repeat(64) };
  const paths = [];
  const fetcher = async url => {
    paths.push(url);
    return new Response(JSON.stringify({ schemaVersion: '0.1', mode: 'devnet',
      asOf: Math.floor(Date.now() / 1000), data: [observation] }), { status: 200 });
  };
  const api = createObservedReferenceReadApi('https://example.test', fetcher);
  const history = await api.getHistory(`reference:market:${observation.slug}`, '1D');
  assert.match(paths.at(-1), /sinceMs=0$/);
  assert.equal(history.source.asOfMs, observation.observedAtMs);
  assert.equal(history.series[0].points.at(-1).value, observation.value);
  assert.equal(history.series[1].evidence, 'ILLUSTRATIVE');
  assert.equal(history.series[1].points.at(-1).atMs, observation.observedAtMs);
});
