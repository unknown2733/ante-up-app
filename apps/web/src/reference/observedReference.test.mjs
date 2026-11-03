import assert from 'node:assert/strict';
import test from 'node:test';
import { createObservedReferenceReadApi, mergeReferenceHistory } from './observedReference.ts';
import { referenceConsumerReadApi } from './referenceData.ts';

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
  assert.equal(history.series.length, 1, 'two measured points replace the illustrative preview');
  assert.equal(history.series[0].points.at(-1).value, observation.value);
  assert.equal(history.series[0].evidence, undefined);
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

test('Explore history falls back to the measured latest count when its history request fails', async () => {
  const capturedAtMs = Date.parse('2026-10-30T12:00:00Z');
  const latest = { slug: 'spotify-2ZaL63zLMDr6H18El2EIt9', kind: 'SPOTIFY_STREAMS',
    aggregation: 'cumulative', value: '48920916', observedAtMs: Date.parse('2026-10-22T00:00:00Z'),
    capturedAtMs, reportedDate: '2026-10-22', provider: 'Kworb',
    sourceUrl: 'https://kworb.net/spotify/artist/0cmWgDlu9CwTgxPhf403hb_songs.html',
    rawSha256: 'd'.repeat(64) };
  const api = createObservedReferenceReadApi('https://example.test', async url =>
    url.endsWith('/latest')
      ? new Response(JSON.stringify({ schemaVersion: '0.1', mode: 'devnet',
        asOf: Math.floor(capturedAtMs / 1000), data: [latest] }), { status: 200 })
      : new Response(null, { status: 503 }));
  const id = `reference:market:${latest.slug}`;
  const market = (await api.listMarkets()).find(item => item.id === id);
  const history = await api.getHistory(id, 'ALL');
  assert.equal(market.activity.value, latest.value);
  assert.equal(history.market.activity.value, latest.value);
  assert.equal(history.series[0].points.at(-1).value, latest.value);
  assert.equal(history.series[0].points.at(-1).atMs, latest.observedAtMs);
  assert.equal(history.series.some(series => series.evidence === 'ILLUSTRATIVE'), false);
});

test('a failed latest request clears the cached observation before a history fallback', async () => {
  const capturedAtMs = Date.parse('2026-10-30T12:00:00Z');
  const latest = { slug: 'youtube-S0Q4gqBUs7c', kind: 'YOUTUBE_VIEWS',
    aggregation: 'cumulative', value: '14200000', observedAtMs: capturedAtMs,
    capturedAtMs, reportedDate: null, provider: 'YouTube',
    sourceUrl: 'https://www.youtube.com/watch?v=S0Q4gqBUs7c',
    rawSha256: 'e'.repeat(64) };
  let latestAvailable = true;
  const api = createObservedReferenceReadApi('https://example.test', async url =>
    url.endsWith('/latest') && latestAvailable
      ? new Response(JSON.stringify({ schemaVersion: '0.1', mode: 'devnet',
        asOf: Math.floor(capturedAtMs / 1000), data: [latest] }), { status: 200 })
      : new Response(null, { status: 503 }));
  const id = `reference:market:${latest.slug}`;
  assert.equal((await api.listMarkets()).find(item => item.id === id).activity.value, latest.value);
  assert.equal((await api.getHistory(id, 'ALL')).series[0].points.at(-1).value, latest.value);
  latestAvailable = false;
  assert.equal((await api.listMarkets()).find(item => item.id === id).activity.value, '14169301');
  assert.equal((await api.getHistory(id, 'ALL')).series[0].points.at(-1).value, '14169301');
});

test('older provider report dates are fetched without a synthetic trend once two observations exist', async () => {
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
  assert.equal(history.series.length, 1);
  assert.equal(history.series[0].points.at(-1).atMs, observation.observedAtMs);
  assert.equal(history.series[0].timeBasis, 'REPORT_DATE');
  assert.equal(history.series[0].label, 'Spotify cumulative streams');
});

test('YouTube skipped five-minute slots remain chart gaps despite startup jitter',async()=>{
  const start=Date.parse('2026-11-03T08:00:00Z');
  const rows=[1000,329000,601000,1201000].map((offset,index)=>({
    slug:'youtube-S0Q4gqBUs7c',kind:'YOUTUBE_VIEWS',aggregation:'cumulative',
    value:String(14200000+index),observedAtMs:start+offset,capturedAtMs:start+offset,
    reportedDate:null,provider:'YouTube Data API',sourceUrl:'https://www.youtube.com/watch?v=S0Q4gqBUs7c',
    rawSha256:String(index).repeat(64),
  }));
  const base=await referenceConsumerReadApi.getHistory('reference:market:youtube-S0Q4gqBUs7c','1D');
  const history=mergeReferenceHistory(base,rows);
  assert.deepEqual(history.series[0].gaps,[{fromMs:start+601000,toMs:start+1201000}]);
  assert.equal(history.series[0].points.length,4);
});

test('a successful older history cannot undo the latest dated report revision',async()=>{
  const old={slug:'spotify-2ZaL63zLMDr6H18El2EIt9',kind:'SPOTIFY_STREAMS',aggregation:'cumulative',
    value:'49024100',observedAtMs:Date.parse('2026-11-01T00:00:00Z'),
    capturedAtMs:Date.parse('2026-11-02T01:00:00Z'),reportedDate:'2026-11-01',provider:'Kworb',
    sourceUrl:'https://kworb.net/spotify/artist/0cmWgDlu9CwTgxPhf403hb_songs.html',rawSha256:'a'.repeat(64)};
  const latest={...old,value:'49024000',capturedAtMs:old.capturedAtMs+1000,rawSha256:'b'.repeat(64)};
  const api=createObservedReferenceReadApi('https://example.test',async url=>new Response(JSON.stringify({
    schemaVersion:'0.1',mode:'devnet',asOf:Math.floor(Date.now()/1000),data:[url.endsWith('/latest')?latest:old],
  })));
  const id=`reference:market:${old.slug}`;
  const market=(await api.listMarkets()).find(item=>item.id===id);
  const history=await api.getHistory(id,'ALL');
  assert.equal(market.activity.value,latest.value);
  assert.equal(history.market.activity.value,latest.value);
  assert.equal(history.series[0].points.at(-1).value,latest.value);
  assert.equal(history.series[0].points.at(-1).atMs,old.observedAtMs);
  assert.equal(history.market.phase,'PREVIEW');
  assert.equal(history.market.latestPrice,null);
});
