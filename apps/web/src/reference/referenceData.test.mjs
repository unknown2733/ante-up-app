import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { referenceSubjects } from '../../../../contracts/reference/catalog.ts';
import { referenceSnapshot } from '../../../../contracts/reference/snapshot.ts';
import { referenceConsumerReadApi as api, isReferenceConsumerId } from './referenceData.ts';

test('all real subjects retain provenance without fabricated financial or social state', async () => {
  const markets = await api.listMarkets();
  assert.equal(markets.length, 15);
  assert.deepEqual(new Set(markets.map(market => market.subject)), new Set(['KEYWORD', 'VIDEO', 'TRACK', 'ALBUM', 'ACCOUNT']));
  for (const market of markets) {
    assert.ok(isReferenceConsumerId(market.id));
    assert.equal(market.source.mode, 'REFERENCE');
    assert.equal(market.phase, 'PREVIEW');
    assert.equal(market.latestPrice, null);
    assert.equal(market.changeFraction, null);
    assert.equal(market.priceUnit, 'tUSD');
    assert.equal(market.liveMarketId, undefined);
    for (const url of [market.subjectUrl, market.thumbnailUrl, market.imageSourceUrl, market.source.sourceUrl]) assert.equal(new URL(url).protocol, 'https:');
    assert.deepEqual((await api.getHistory(market.id, 'ALL')).actions, []);
  }
  assert.equal(await api.getProfile('reference:wallet:anyone'), null);
  assert.equal(await api.getProfile('demo:wallet:ava'), null);
  assert.deepEqual((await api.getLeaderboard('ALL')).rows, []);
  assert.equal(await api.getHistory('demo:market:northbound', 'ALL'), null);
});

test('every displayed observation equals its preserved public API response', async () => {
  for (const subject of referenceSnapshot.subjects.filter(item => item.activity)) {
    const activity = subject.activity;
    const raw = await readFile(new URL(`../../../../contracts/reference/${activity.rawFile}`, import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'), activity.rawSha256);
    const items = JSON.parse(raw).items;
    assert.deepEqual(activity.points, items.map(item => ({ date: `${item.timestamp.slice(0,4)}-${item.timestamp.slice(4,6)}-${item.timestamp.slice(6,8)}`, views: item.views })));
    assert.ok(items.every(item => item.article === activity.article && item.project === 'en.wikipedia' && item.access === 'all-access' && item.agent === 'user' && item.granularity === 'daily'));
    const history = await api.getHistory(`reference:market:${subject.slug}`, 'ALL');
    assert.equal(history.series.length, 1);
    assert.equal(history.series[0].kind, 'ACTIVITY_COUNT');
    assert.equal(history.series[0].unit, 'views/day');
    assert.deepEqual(history.series[0].points.map(point => point.value), items.map(item => String(item.views)));
    assert.ok(history.series[0].points.every(point => point.observationId.startsWith('wikimedia:') && point.atMs <= history.source.asOfMs));
    assert.ok(history.source.asOfMs < Date.parse(activity.capturedAt));
    assert.equal(history.market.activity.value, String(activity.points.at(-1).views));
    const last = activity.points.at(-1), previous = activity.points.at(-8);
    assert.equal(history.market.activity.changeFraction, previous.views ? last.views / previous.views - 1 : null);
  }
});

test('daily periods never invent intraday points, fills, prices, or proxy histories', async () => {
  for (const subject of referenceSubjects) {
    const id = `reference:market:${subject.slug}`;
    for (const [period, days] of [['1D', 1], ['1W', 7], ['1M', 30], ['ALL', 45]]) {
      const history = await api.getHistory(id, period);
      if (!subject.wikipediaArticle) {
        assert.deepEqual(history.series, []);
        assert.equal(history.market.activity, undefined);
        continue;
      }
      assert.equal(history.series[0].points.length, days);
      for (const point of history.series[0].points) assert.equal(point.atMs % 86_400_000, 0);
      assert.match(history.source.label, /English Wikipedia/);
    }
  }
});

test('returned public objects cannot mutate the saved snapshot or next read', async () => {
  const first = await api.listMarkets();
  const title = first[0].title;
  first[0].title = 'Mutated';
  const history = await api.getHistory(first[0].id, 'ALL');
  history.series[0].points[0].value = '-1';
  assert.equal((await api.listMarkets())[0].title, title);
  assert.notEqual((await api.getHistory(first[0].id, 'ALL')).series[0].points[0].value, '-1');
});
