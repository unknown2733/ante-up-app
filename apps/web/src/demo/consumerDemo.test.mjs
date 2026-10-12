import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoConsumerReadApi, demoConsumerReadApi, DEMO_AS_OF_MS, isDemoConsumerId } from './consumerDemo.ts';
import { demoActors, demoScenarioFixtures } from '../../../../contracts/fixtures/consumer/catalog.ts';

const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('fifteen fictional markets cover every subject and several time narratives', async () => {
  const markets = await demoConsumerReadApi.listMarkets();
  assert.equal(markets.length, 15);
  assert.deepEqual(new Set(markets.map(market => market.subject)), new Set(['KEYWORD', 'VIDEO', 'TRACK', 'ALBUM', 'ACCOUNT']));
  assert.deepEqual(new Set(demoScenarioFixtures.map(scenario => scenario.story)),
    new Set(['GROWTH', 'SLOWDOWN', 'REVIVAL', 'LOSS', 'SIDEWAYS', 'WAITING']));
  assert.ok(markets.every(market => isDemoConsumerId(market.id) && !market.liveMarketId && market.source.mode === 'DEMO'));
  assert.ok(markets.every(market => market.source.asOfMs === DEMO_AS_OF_MS && !market.source.sourceUrl));
  assert.equal(markets.filter(market => market.phase === 'PREVIEW').length, 1);
});

test('each market has a fixed five-week history with typed prices and no false fills', async () => {
  for (const market of await demoConsumerReadApi.listMarkets()) {
    const history = await demoConsumerReadApi.getHistory(market.id, 'ALL');
    assert.ok(history);
    assert.equal(history.source.mode, 'DEMO');
    assert.equal(history.series[0].kind, 'ATTENTION_INDEX');
    assert.equal(history.series[0].points[0].atMs, DEMO_AS_OF_MS - 35 * 86_400_000);
    assert.equal(history.series[0].points.at(-1).atMs, DEMO_AS_OF_MS);
    assert.ok(history.series.every(series => series.points.every(point =>
      point.observationId.startsWith('demo:synthetic-point:'))));
    assert.ok(history.actions.every(action => action.kind.startsWith('CALL_') && action.source.mode === 'DEMO'));
    const price = history.series[1];
    if (market.phase === 'PREVIEW') {
      assert.equal(price, undefined);
      assert.equal(market.latestPrice, null);
      assert.equal(market.changeFraction, null);
    } else {
      assert.equal(price.kind, market.phase === 'POOL' ? 'REFERENCE_PRICE' : 'CURVE_PRICE');
      assert.equal(market.latestPrice, price.points.at(-1).value);
      const weekAgo = price.points.find(point => point.atMs === DEMO_AS_OF_MS - 7 * 86_400_000);
      approx(market.changeFraction, Number(price.points.at(-1).value) / Number(weekAgo.value) - 1);
    }
    const week = await demoConsumerReadApi.getHistory(market.id, '1W');
    assert.ok(week.series.every(series => series.points.every(point => point.atMs >= DEMO_AS_OF_MS - 7 * 86_400_000)));
    assert.ok(week.actions.every(action => action.atMs >= DEMO_AS_OF_MS - 7 * 86_400_000));
  }
  const gap = await demoConsumerReadApi.getHistory('demo:market:weekend-letters', 'ALL');
  assert.deepEqual(gap.series[0].gaps, [{
    fromMs: DEMO_AS_OF_MS - 20 * 86_400_000,
    toMs: DEMO_AS_OF_MS - 17 * 86_400_000,
  }]);
});

test('1D and 1W use generated hourly shapes while all periods agree at shared times', async () => {
  const periods = ['1D', '1W', '1M', 'ALL'];
  const expectedStep = { '1D': 3_600_000, '1W': 3_600_000, '1M': 6 * 3_600_000, ALL: 86_400_000 };
  const expectedCount = { '1D': 25, '1W': 169, '1M': 121, ALL: 36 };
  for (const market of await demoConsumerReadApi.listMarkets()) {
    const histories = Object.fromEntries(await Promise.all(periods.map(async period =>
      [period, await demoConsumerReadApi.getHistory(market.id, period)])));
    const all = histories.ALL;
    for (const period of periods) {
      const history = histories[period];
      const startMs = DEMO_AS_OF_MS - ({ '1D': 1, '1W': 7, '1M': 30, ALL: 35 })[period] * 86_400_000;
      for (const series of history.series) {
        assert.equal(series.points[0].atMs, startMs);
        assert.equal(series.points.at(-1).atMs, DEMO_AS_OF_MS);
        assert.equal(series.points.length, expectedCount[period] - (market.id.endsWith('weekend-letters')
          ? period === '1M' ? 12 : period === 'ALL' ? 3 : 0 : 0));
        assert.ok(series.points.every(point => (point.atMs - startMs) % expectedStep[period] === 0));
        const daily = all.series.find(candidate => candidate.id === series.id);
        for (const point of series.points) {
          const shared = daily.points.find(candidate => candidate.atMs === point.atMs);
          if (shared) assert.equal(point.value, shared.value);
        }
      }
      for (const action of history.actions) {
        const h = history.series.find(series => series.id === action.seriesId);
        assert.equal(action.value, h.points.find(point => point.atMs === action.atMs)?.value);
      }
    }
    const hourly = histories['1D'].series[0].points;
    assert.ok(new Set(hourly.map(point => point.value)).size > 10, market.id);
    assert.ok(hourly.slice(1, -1).some((point, index) =>
      Math.abs(Number(hourly[index].value) - 2 * Number(point.value) + Number(hourly[index + 2].value)) > 1e-6),
    `Expected non-linear hourly texture for ${market.id}`);
    assert.ok(Buffer.byteLength(JSON.stringify(histories['1W'])) < 50_000);
  }
  const gapMarket = await demoConsumerReadApi.getHistory('demo:market:weekend-letters', '1M');
  const gap = gapMarket.series[0].gaps[0];
  assert.equal(gap.fromMs, DEMO_AS_OF_MS - 20 * 86_400_000);
  assert.equal(gap.toMs, DEMO_AS_OF_MS - 17 * 86_400_000);
  assert.ok(gapMarket.series.every(series => series.points.every(point =>
    point.atMs < gap.fromMs || point.atMs >= gap.toMs)));
});

test('call markers, notes and closed performance refer to their own entry and exit', async () => {
  let positive = 0;
  let negative = 0;
  let ongoing = 0;
  for (const market of await demoConsumerReadApi.listMarkets()) {
    const history = await demoConsumerReadApi.getHistory(market.id, 'ALL');
    const h = history.series[0];
    const byRecord = Map.groupBy(history.actions, action => action.recordId);
    for (const actions of byRecord.values()) {
      const open = actions.find(action => action.kind === 'CALL_OPEN');
      const close = actions.find(action => action.kind === 'CALL_CLOSE');
      assert.ok(open);
      assert.equal(open.returnFraction, null);
      for (const action of actions) {
        assert.equal(action.seriesId, h.id);
        assert.equal(action.value, h.points.find(point => point.atMs === action.atMs).value);
        assert.ok(isDemoConsumerId(action.actorId) && isDemoConsumerId(action.recordId));
        if (action.note) {
          assert.equal(action.note.actionId, action.id);
          assert.equal(action.note.authorId, action.actorId);
          assert.equal(action.note.proofCoverage, 'NONE');
          assert.ok(action.note.createdAtMs >= action.atMs && action.note.updatedAtMs <= DEMO_AS_OF_MS);
          assert.ok([...action.note.body].length <= 280);
        }
      }
      if (close) {
        assert.ok(close.atMs > open.atMs);
        approx(close.returnFraction, Number(close.value) / Number(open.value) - 1);
        if (close.returnFraction > 0) positive++;
        if (close.returnFraction < 0) negative++;
      } else ongoing++;
    }
  }
  assert.ok(positive >= 10 && negative >= 8 && ongoing >= 2, { positive, negative, ongoing });
});

test('demo profiles and leaderboards use closed calls only and keep time windows separate', async () => {
  const actions = (await Promise.all((await demoConsumerReadApi.listMarkets()).map(market =>
    demoConsumerReadApi.getHistory(market.id, 'ALL')))).flatMap(history => history.actions);
  for (const actor of demoActors) {
    const profile = await demoConsumerReadApi.getProfile(actor.id);
    const actorActions = actions.filter(action => action.actorId === actor.id);
    const closed = actorActions.filter(action => action.kind === 'CALL_CLOSE');
    assert.equal(profile.closedCallCount, closed.length);
    assert.equal(profile.openCallCount, actorActions.filter(action => action.kind === 'CALL_OPEN').length - closed.length);
    approx(profile.meanReturnFraction, closed.reduce((sum, action) => sum + action.returnFraction, 0) / closed.length);
  }
  for (const period of ['7D', 'ALL']) {
    const board = await demoConsumerReadApi.getLeaderboard(period);
    assert.equal(board.source.mode, 'DEMO');
    for (const row of board.rows) {
      const closed = actions.filter(action => action.actorId === row.actorId && action.kind === 'CALL_CLOSE' &&
        (period === 'ALL' || action.atMs >= DEMO_AS_OF_MS - 7 * 86_400_000));
      assert.equal(row.closedCallCount, closed.length);
      approx(row.meanReturnFraction, closed.reduce((sum, action) => sum + action.returnFraction, 0) / closed.length);
    }
    assert.ok(board.rows.every((row, index) => index === 0 || row.meanReturnFraction <= board.rows[index - 1].meanReturnFraction));
  }
});

test('provider is deterministic, read-only and callers cannot mutate shared fixtures', async () => {
  const first = await demoConsumerReadApi.listMarkets();
  first[0].title = 'mutated';
  const second = await createDemoConsumerReadApi().listMarkets();
  assert.notEqual(second[0].title, 'mutated');
  assert.deepEqual(second, await demoConsumerReadApi.listMarkets());
  assert.equal(await demoConsumerReadApi.getHistory('demo:market:absent', 'ALL'), null);
  assert.equal(await demoConsumerReadApi.getProfile('demo:wallet:absent'), null);
  assert.equal('openFree' in demoConsumerReadApi, false);
  assert.equal('buy' in demoConsumerReadApi, false);
});
