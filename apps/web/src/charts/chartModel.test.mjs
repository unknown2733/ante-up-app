import test from 'node:test';
import assert from 'node:assert/strict';
import { actionName, actionResult, chartBounds, chartClusters, chartPoints, chartSegments, portraitImageSource, scopedChartHistory, inspectChart, chartViewport } from './chartModel.ts';

test('inspection returns actual observations but never fills a missing interval', () => {
  const points = [{ atMs: 100, value: 1 }, { atMs: 200, value: 9 }, { atMs: 300, value: 4 }];
  const gaps = [{ fromMs: 200, toMs: 300 }];
  assert.equal(inspectChart(points, gaps, 175), points[1]);
  assert.equal(inspectChart(points, gaps, 250), null);
  assert.equal(inspectChart(points, gaps, 200), points[1]);
  assert.equal(inspectChart(points, gaps, 300), points[2]);
  assert.equal(inspectChart([], [], 0), null);
});

test('zoom and pan preserve viewport width and cannot escape available period', () => {
  const full = { start: 100, end: 900 };
  assert.deepEqual(chartViewport(full, 500, 400), { start: 300, end: 700 });
  assert.deepEqual(chartViewport(full, 0, 400), { start: 100, end: 500 });
  assert.deepEqual(chartViewport(full, 1000, 400), { start: 500, end: 900 });
  assert.deepEqual(chartViewport(full, 1000, 2000), full);
});

const asOfMs = Date.UTC(2026, 9, 13);
const source = { mode: 'DEMO', label: 'Sample history', asOfMs };
const market = { id: 'demo:market', title: 'A real subject', subtitle: '', subject: 'TRACK', phase: 'PREVIEW',
  source, latestPrice: null, priceUnit: 'tUSD', changeFraction: null };
const point = (atMs, value) => ({ atMs, value: String(value) });
const series = { id: 'attention', kind: 'ATTENTION_INDEX', label: 'Attention', unit: '×', source,
  points: [point(asOfMs - 86_400_000 - 1, 9), point(asOfMs - 60_000, 1), point(asOfMs - 40_000, 2),
    point(asOfMs - 10_000, 3)],
  gaps: [{ fromMs: asOfMs - 40_000, toMs: asOfMs - 10_000 }] };
const action = (id, kind, atMs, returnFraction = null) => ({ id, marketId: market.id, actorId: 'example:one',
  actorLabel: 'Example participant', kind, atMs, seriesId: 'attention', value: null, returnFraction, note: null, source });
const history = (period, actions = []) => ({ market, source, period, series: [series], actions });

test('period bounds filter older points and actions without changing observed timestamps', () => {
  const oneDay = history('1D', [action('older', 'CALL_OPEN', asOfMs - 86_400_000 - 1),
    action('current', 'CALL_CLOSE', asOfMs - 10_000, -0.1)]);
  const bounds = chartBounds(oneDay);
  assert.equal(bounds.start, asOfMs - 86_400_000);
  assert.deepEqual(chartPoints(series, bounds).map(item => item.atMs), [asOfMs - 60_000, asOfMs - 40_000, asOfMs - 10_000]);
  assert.deepEqual(chartClusters(oneDay.actions, bounds).flatMap(cluster => cluster.actions.map(item => item.id)), ['current']);
  assert.equal(chartBounds(history('1W')).start, asOfMs - 7 * 86_400_000);
  assert.equal(chartBounds(history('1M')).start, asOfMs - 30 * 86_400_000);
  assert.equal(chartBounds(history('ALL')).start, asOfMs - 86_400_000 - 1);
});

test('line breaks at gap boundary and trade points never become a continuous line', () => {
  const bounds = chartBounds(history('1D'));
  const points = chartPoints(series, bounds);
  assert.deepEqual(chartSegments(series, points).map(segment => segment.map(item => item.atMs)),
    [[asOfMs - 60_000, asOfMs - 40_000], [asOfMs - 10_000]]);
  assert.deepEqual(chartSegments({ ...series, kind: 'TRADE_PRICE' }, points), []);
});

test('nearby chip markers cluster while retaining each action and order', () => {
  const near = [action('open', 'CALL_OPEN', asOfMs - 59_000), action('close', 'CALL_CLOSE', asOfMs - 58_000, 0.15),
    action('later', 'CALL_OPEN', asOfMs - 10_000)];
  const clusters = chartClusters(near, { start: asOfMs - 120_000, end: asOfMs });
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].actions.map(item => item.id), ['open', 'close']);
  assert.equal(clusters[1].actions[0].id, 'later');
  const mobileClusters = chartClusters([...near, action('mid', 'CALL_OPEN', asOfMs - 48_000)],
    { start: asOfMs - 120_000, end: asOfMs }, 88);
  assert.equal(mobileClusters.length, 2);
  assert.deepEqual(mobileClusters[0].actions.map(item => item.id), ['open', 'close', 'mid']);
});

test('chip activity copy distinguishes attention performance and illustrative trades', () => {
  assert.equal(actionName.CALL_OPEN, 'Placed a chip');
  assert.equal(actionName.CALL_CLOSE, 'Took back a chip');
  assert.equal(actionResult(action('open', 'CALL_OPEN', asOfMs)), 'Chip placed');
  assert.equal(actionResult(action('loss', 'CALL_CLOSE', asOfMs, -0.12)), 'Attention change -12%');
  assert.equal(actionResult(action('na', 'CALL_CLOSE', asOfMs)), 'Attention change unavailable');
  assert.equal(actionResult(action('buy', 'BUY', asOfMs)), 'Example trade');
});

test('chart evidence stays in its market and sample or live lane', () => {
  const valid = action('valid', 'CALL_OPEN', asOfMs - 10_000);
  const wrongMarket = { ...valid, id: 'wrong-market', marketId: 'another-market' };
  const live = { ...valid, id: 'live', source: { ...source, mode: 'LIVE' } };
  const result = scopedChartHistory({ ...history('ALL', [valid, wrongMarket, live]),
    series: [series, { ...series, id: 'live-series', source: { ...source, mode: 'LIVE' } }] });
  assert.deepEqual(result.actions.map(item => item.id), ['valid']);
  assert.deepEqual(result.series.map(item => item.id), ['attention']);
});

test('a failed portrait falls back, then a changed source can load again', () => {
  assert.equal(portraitImageSource('https://example.test/old.png', 'https://example.test/old.png'), null);
  assert.equal(portraitImageSource('https://example.test/new.png', 'https://example.test/old.png'), 'https://example.test/new.png');
  assert.equal(portraitImageSource(undefined, 'https://example.test/old.png'), null);
});
