import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { platformReferences } from '../../../../contracts/reference/platform-snapshot.ts';
import { historyReferences } from '../../../../contracts/reference/platform-history.ts';
import { referenceConsumerReadApi as api } from './referenceData.ts';

test('catalog exposes exact platform metrics without invented prices, users, or trading rights', async () => {
  const markets = await api.listMarkets();
  assert.equal(markets.length, 12);
  assert.deepEqual(new Set(markets.map(item => item.subject)), new Set(['VIDEO', 'TRACK', 'POST']));
  for (const market of markets) {
    assert.equal(market.source.mode, 'REFERENCE');
    assert.equal(market.phase, 'PREVIEW');
    assert.equal(market.latestPrice, null);
    assert.equal(market.changeFraction, null);
    assert.equal(market.activity.changeFraction, null);
    assert.equal(market.liveMarketId, undefined);
    for (const url of [market.subjectUrl, market.thumbnailUrl, market.imageSourceUrl, market.source.sourceUrl]) assert.equal(new URL(url).protocol, 'https:');
    assert.deepEqual((await api.getHistory(market.id, 'ALL')).actions, []);
    assert.doesNotMatch(JSON.stringify(market), /wikipedia|pageviews/i);
  }
  assert.equal(await api.getProfile('reference:anyone'), null);
  assert.deepEqual((await api.getLeaderboard('ALL')).rows, []);
  assert.equal(await api.getHistory('demo:market:northbound', 'ALL'), null);
  assert.equal(await api.getHistory('reference:market:aurora', 'ALL'), null);
});

test('displayed totals match hashed source extracts for the exact video, post, or track', async () => {
  for (const item of platformReferences) {
    const raw = await readFile(new URL(`../../../../contracts/reference/${item.metric.rawFile}`, import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'), item.metric.rawSha256);
    const evidence = JSON.parse(raw);
    const fields = evidence.fields;
    const kind = item.metric.kind;
    const value = kind === 'YOUTUBE_VIEWS' ? fields.viewCount : kind === 'X_LIKES' ? String(fields.favorite_count) : fields.streams;
    assert.equal(value, item.metric.value);
    const id = kind === 'YOUTUBE_VIEWS' ? new URL(item.subjectUrl).searchParams.get('v') : item.subjectUrl.split('/').at(-1);
    assert.equal(kind === 'YOUTUBE_VIEWS' ? fields.videoId : kind === 'X_LIKES' ? fields.id_str : fields.trackId, id);
    assert.equal(evidence.capturedAt, item.metric.capturedAt);
    assert.match(evidence.fullResponseSha256, /^[a-f0-9]{64}$/);
    const history = await api.getHistory(`reference:market:${item.slug}`, 'ALL');
    assert.equal(history.market.activity.value, value);
    assert.equal(history.market.activity.unit, item.metric.unit);
    assert.equal(history.series[0].points.at(-1).value, value);
    if (kind === 'SPOTIFY_STREAMS') {
      assert.equal(item.metric.sourceType, 'THIRD_PARTY');
      assert.equal(fields.reportedDate, item.metric.reportedDate);
      assert.match(history.source.label, /Kworb.*third-party report/);
      assert.ok(history.source.observationLabel.includes(fields.reportedDate));
      assert.equal(item.metric.asOf, item.metric.capturedAt, 'do not invent an exact timestamp for a date-only report');
      assert.equal(new URL(item.subjectUrl).hostname, 'open.spotify.com');
    }
  }
});

test('all periods preserve one captured point without interpolation, proxy metrics, or invented changes', async () => {
  for (const item of platformReferences) {
    if (historyReferences.some(history => history.slug === item.slug)) continue;
    for (const period of ['1D', '1W', '1M', 'ALL']) {
      const history = await api.getHistory(`reference:market:${item.slug}`, period);
      assert.equal(history.series.length, 1);
      const series = history.series[0];
      assert.equal(series.kind, 'ACTIVITY_COUNT');
      assert.deepEqual(series.points, [{ atMs: Date.parse(item.metric.asOf), value: item.metric.value, observationId: `public:${item.metric.rawSha256}` }]);
      assert.deepEqual(series.gaps, []);
      assert.equal(history.market.activity.changeFraction, null);
    }
  }
});

test('historical adapter preserves exact reported dates, daily scope, sparse gaps and period bounds', async () => {
  for (const item of historyReferences) {
    const all = await api.getHistory(`reference:market:${item.slug}`, 'ALL');
    assert.deepEqual(all.series[0].points.map(p => ({ date: p.reportedDate, value: p.value })), item.points.map(p => ({ date: p.date, value: p.value })));
    assert.equal(all.source.asOfMs, Date.parse(`${item.points.at(-1).date}T00:00:00Z`));
    assert.equal(all.series[0].aggregation, item.aggregation);
    assert.equal(all.series[0].timeBasis, 'REPORT_DATE');
    assert.equal(all.series[0].gaps.length, item.aggregation === 'cumulative' ? 2 : 0);
    assert.equal(all.market.activity.unit.endsWith('/day'), item.aggregation === 'daily');
    for (const [period, days] of [['1D', 1], ['1W', 7], ['1M', 30]]) {
      const history = await api.getHistory(all.market.id, period);
      const expected = all.series[0].points.filter(p => p.atMs >= all.source.asOfMs - days * 86400000);
      assert.deepEqual(history.series[0].points, expected);
      assert.equal(history.market.latestPrice, null);
      assert.equal(history.market.activity.changeFraction, null);
      assert.deepEqual(history.actions, []);
    }
  }
});

test('returned data cannot mutate subsequent reads', async () => {
  const first = await api.listMarkets();
  const title = first[0].title;
  first[0].title = 'Mutated';
  const history = await api.getHistory(first[0].id, 'ALL');
  history.series[0].points[0].value = '-1';
  assert.equal((await api.listMarkets())[0].title, title);
  assert.notEqual((await api.getHistory(first[0].id, 'ALL')).series[0].points[0].value, '-1');
});
