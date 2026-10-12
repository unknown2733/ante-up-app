import assert from 'node:assert/strict';
import test from 'node:test';
import { createIllustrativeHistory } from './illustrativeHistory.ts';
import { referenceConsumerReadApi } from './referenceData.ts';

test('layout values are stable, positive, daily, explicitly generated and end at index100', async () => {
  const [market] = await referenceConsumerReadApi.listMarkets();
  const original = structuredClone(market);
  const all = createIllustrativeHistory(market, 'ALL');
  assert.deepEqual(all, createIllustrativeHistory(market, 'ALL'));
  assert.equal(all.evidence, 'ILLUSTRATIVE');
  assert.equal(all.kind, 'ATTENTION_INDEX');
  assert.equal(all.unit, 'preview index');
  assert.equal(all.points.length, 29);
  assert.equal(all.points[0].atMs, market.source.asOfMs - 28 * 86_400_000);
  assert.deepEqual(all.points.at(-1), { atMs: market.source.asOfMs, value: '100.00' });
  assert.ok(all.points.every(point => Number(point.value) > 0 && Object.keys(point).sort().join(',') === 'atMs,value'));
  for (let i = 1; i < all.points.length; i++) assert.equal(all.points[i].atMs - all.points[i - 1].atMs, 86_400_000);
  assert.equal(all.source.mode, 'REFERENCE');
  assert.equal(all.source.sourceUrl, undefined);
  assert.match(all.source.label, /Illustrative.*not measured/);
  assert.equal(all.timeBasis, undefined);
  assert.equal(all.aggregation, undefined);
  assert.deepEqual(all.gaps, []);
  assert.deepEqual(market, original);
  assert.notDeepEqual(all.points, createIllustrativeHistory({ ...market, id: `${market.id}:different` }, 'ALL').points);
});

test('every period is a slice of the same generated series with inclusive day boundaries', async () => {
  const [market] = await referenceConsumerReadApi.listMarkets();
  const all = createIllustrativeHistory(market, 'ALL');
  for (const [period, days, length] of [['1D', 1, 2], ['1W', 7, 8], ['1M', 30, 29], ['ALL', Infinity, 29]]) {
    const subset = createIllustrativeHistory(market, period);
    assert.equal(subset.points.length, length);
    assert.deepEqual(subset.points, all.points.filter(point => point.atMs >= market.source.asOfMs - days * 86_400_000));
  }
});

test('illustrative helper refuses live markets and invalid as-of dates', async () => {
  const [market] = await referenceConsumerReadApi.listMarkets();
  assert.equal(createIllustrativeHistory({ ...market, source: { ...market.source, mode: 'LIVE' } }, 'ALL'), null);
  assert.equal(createIllustrativeHistory({ ...market, source: { ...market.source, asOfMs: NaN } }, 'ALL'), null);
});
