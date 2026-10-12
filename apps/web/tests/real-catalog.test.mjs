import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root: appDir, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => server.close());
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const noAction = () => { throw new Error('Read-only rendering must not perform an action'); };
const source = { mode: 'REFERENCE', label: 'Wikimedia article pageviews', asOfMs: Date.UTC(2026, 9, 12), sourceUrl: 'https://en.wikipedia.org/wiki/Test_article' };
// Distinct values catch accidental use of the market quote in place of its public metric.
const market = {
  id: 'reference:test-article', title: 'A public subject', subtitle: 'Article reference', subject: 'TRACK',
  phase: 'PREVIEW', source, latestPrice: '999', priceUnit: 'tUSD', changeFraction: 9,
  activity: { value: '1234', unit: 'pageviews', label: 'Wikipedia article pageviews', changeFraction: 0.25, asOfMs: source.asOfMs },
};

test('reference adapter exposes public observations without financial or wallet history', async () => {
  const { referenceConsumerReadApi: api, isReferenceConsumerId } = await server.ssrLoadModule('/src/reference/referenceData.ts');
  const markets = await api.listMarkets();
  assert.ok(markets.length > 0, 'public reference catalog must not be empty');
  let observedSeries = 0;
  for (const item of markets) {
    assert.ok(isReferenceConsumerId(item.id));
    assert.equal(item.source.mode, 'REFERENCE');
    assert.equal(item.phase, 'PREVIEW');
    assert.equal(item.latestPrice, null, `${item.id}: reference must not have a token quote`);
    assert.equal(item.changeFraction, null, `${item.id}: reference must not have a price return`);
    assert.ok(!item.liveMarketId, `${item.id}: reference must not authorize a live market`);
    assert.ok(Number.isFinite(item.source.asOfMs));
    assert.match(item.source.sourceUrl, /^https:\/\//);
    const history = await api.getHistory(item.id, 'ALL');
    assert.ok(history);
    assert.equal(history.source.mode, 'REFERENCE');
    assert.deepEqual(history.actions, [], `${item.id}: no invented chips, trades, notes or attestations`);
    for (const series of history.series) {
      observedSeries++;
      assert.equal(series.kind, 'ACTIVITY_COUNT');
      assert.equal(series.source.mode, 'REFERENCE');
      assert.ok(series.points.length > 0);
      assert.match(series.label, /views|likes|streams/i);
      assert.ok(series.points.every(point => Number.isFinite(point.atMs) && Number.isFinite(Number(point.value))));
    }
    assert.equal(await api.getProfile(item.id), null);
  }
  assert.ok(observedSeries > 0, 'at least one reference must carry fetched activity');
  assert.equal(await api.getProfile('demo:wallet:ava'), null);
  for (const period of ['7D', 'ALL']) {
    const board = await api.getLeaderboard(period);
    assert.equal(board.source.mode, 'REFERENCE');
    assert.deepEqual(board.rows, []);
  }
  assert.equal(await api.getHistory('demo:market', 'ALL'), null);
});

test('discovery renders the public activity metric and UTC observation date, not a token quote', async () => {
  const { MarketDiscovery } = await server.ssrLoadModule('/src/consumer-ui/MarketDiscovery.tsx');
  const html = render(MarketDiscovery, { markets: [market], onSelectMarket: noAction });
  assert.match(html, /Public source/);
  assert.match(html, /Oct 12, 2026/);
  assert.match(html, /1,234 pageviews/);
  assert.match(html, /Wikipedia article pageviews/);
  assert.match(html, /\+25%/);
  assert.doesNotMatch(html, /999 tUSD|\+900%|Sample history|Example activity|Devnet observed/);
});

test('reference chart preserves the actual activity metric, units, dates and source link', async () => {
  const { ConsumerChart } = await server.ssrLoadModule('/src/charts/ConsumerChart.tsx');
  const history = {
    market, period: 'ALL', source, actions: [],
    series: [{ id: 'reference:pageviews', kind: 'ACTIVITY_COUNT', label: market.activity.label, unit: 'pageviews', source,
      points: [{ atMs: Date.UTC(2026, 9, 11), value: '1000' }, { atMs: source.asOfMs, value: '1234' }], gaps: [] }],
  };
  const html = render(ConsumerChart, { history, onSelectAction: noAction });
  assert.match(html, /Public source data/);
  assert.match(html, /Wikipedia article pageviews/);
  assert.match(html, /pageviews · 2 points/);
  assert.match(html, /Oct 11/);
  assert.match(html, /Oct 12/);
  assert.ok(html.includes(`href="${source.sourceUrl}"`));
  assert.doesNotMatch(html, /Live Devnet|Sample history|Curve price|Trade price|tUSD|au-chart-marker /);
});

test('production App has no synthetic consumer adapter or example leaderboard', () => {
  const app = readFileSync(resolve(appDir, 'src/App.tsx'), 'utf8');
  assert.doesNotMatch(app, /from\s+['"][^'"]*\/demo\//);
  assert.doesNotMatch(app, /\bdemoConsumerReadApi\b|\bdemoActors\b|Example leaderboard|mode=demo/);
});

test('unconnected subjects retain all action tabs without enabling quotes or wallet execution', async () => {
  const { ReferenceMarketActions } = await server.ssrLoadModule('/src/reference/ReferenceMarketActions.tsx');
  for (const section of ['call', 'trade', 'pro', 'liquidity']) {
    const html = render(ReferenceMarketActions, { section, onChange: noAction });
    assert.equal((html.match(/role="tab"/g) ?? []).length, 4);
    assert.match(html, /Chips/);
    assert.match(html, /Buy \/ Sell/);
    assert.match(html, /Pro/);
    assert.match(html, /Liquidity/);
    assert.match(html, /Not connected/);
    assert.match(html, /disabled="" aria-describedby="reference-action-reason"/);
    assert.ok(html.includes('href="/docs/markets-trading"'));
    assert.doesNotMatch(html, /Sign in wallet|Get quote|Connect wallet to trade/);
    if (section !== 'call') assert.match(html, /disabled="" placeholder="Available when this market opens"/);
  }
  const app = readFileSync(resolve(appDir, 'src/App.tsx'), 'utf8');
  assert.match(app, /mode === 'REFERENCE' \? <ReferenceMarketActions/);
  const panel = readFileSync(resolve(appDir, 'src/reference/ReferenceMarketActions.tsx'), 'utf8');
  assert.doesNotMatch(panel, /liveFinancialFlow|liveFreeFlow|FinancialMarket|currentWalletContext|fetch\(/);
});

test('single captured platform count renders its date and source without inventing a history', async () => {
  const { ConsumerChart } = await server.ssrLoadModule('/src/charts/ConsumerChart.tsx');
  const { referenceConsumerReadApi: api } = await server.ssrLoadModule('/src/reference/referenceData.ts');
  const markets = await api.listMarkets();
  for (const subject of markets) {
    const history = await api.getHistory(subject.id, 'ALL');
    if (history.series[0].timeBasis === 'REPORT_DATE') continue;
    const html = render(ConsumerChart, { history, onSelectAction: noAction, onPeriodChange: noAction });
    assert.match(html, /au-chart-snapshot/);
    assert.ok(html.includes(new Intl.NumberFormat('en').format(Number(subject.activity.value))));
    assert.ok(html.includes(subject.activity.unit));
    assert.ok(html.includes(new Date(subject.source.asOfMs).toISOString()));
    assert.ok(html.includes(`href="${subject.source.sourceUrl}"`));
    assert.doesNotMatch(html, /<svg|Chart period|au-chart-marker /);
    if (subject.subject === 'TRACK') assert.match(html, /Kworb report dated.*time zone not supplied/);
  }
});

test('historical reports display dated values and preserve sparse gaps across periods', async () => {
  const { ConsumerChart } = await server.ssrLoadModule('/src/charts/ConsumerChart.tsx');
  const { referenceConsumerReadApi: api } = await server.ssrLoadModule('/src/reference/referenceData.ts');
  const subjects = (await api.listMarkets()).filter(market => market.activity.historyLabel);
  assert.equal(subjects.length, 5);
  for (const subject of subjects) {
    for (const period of ['ALL', '1D', '1W', '1M']) {
      const history = await api.getHistory(subject.id, period);
      const series = history.series[0];
      const html = render(ConsumerChart, { history, onSelectAction: noAction, onPeriodChange: noAction });
      assert.match(html, /Chart period/);
      assert.match(html, /Report dates/);
      assert.match(html, /no live feed/);
      assert.equal((html.match(/<circle /g) ?? []).length, series.points.length);
      for (const point of series.points) {
        assert.ok(html.toLowerCase().includes(`datetime="${point.reportedDate}"`));
        assert.ok(html.includes(new Intl.NumberFormat('en').format(Number(point.value))));
        assert.ok(html.includes(`href="${point.sourceUrl.replace(/&/g, '&amp;')}"`));
      }
      if (series.aggregation === 'cumulative') assert.doesNotMatch(html, /<polyline/);
      assert.doesNotMatch(html, /au-chart-snapshot|au-chart-marker |12:00 AM/);
    }
  }
});

test('legacy synthetic routes cannot render a market, profile, record or proof', async () => {
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { location: { pathname: '/', search: '' } };
    const { default: App } = await server.ssrLoadModule('/src/App.tsx');
    for (const path of ['/markets/demo%3Asolana', '/u/demo%3Awallet%3Aava', '/records/demo%3Arecord', '/proofs/demo%3Aproof']) {
      globalThis.window.location = { pathname: path, search: '?mode=demo' };
      const html = render(App, {});
      assert.match(html, /Page not found/, path);
      assert.doesNotMatch(html, /Sample history|Example leaderboard|My sample profile|Loading profile|Loading market/, path);
    }
    globalThis.window.location = { pathname: '/me', search: '?mode=demo' };
    const own = render(App, {});
    assert.match(own, /Wallet not connected/);
    assert.doesNotMatch(own, /My sample profile|Sample history|Example activity/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
