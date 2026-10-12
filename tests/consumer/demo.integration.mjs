import test from 'node:test';
import assert from 'node:assert/strict';
import { demoConsumerReadApi } from '../../apps/web/src/demo/consumerDemo.ts';
import { auditConsumerSnapshot } from '../../apps/web/qa/consumer/audit.mjs';

test('all committed Demo markets connect dense 1D charts, actions, notes, profiles and ranks', async () => {
  const markets = await demoConsumerReadApi.listMarkets();
  const histories = (await Promise.all(markets.flatMap(market => ['1D', '1W', '1M', 'ALL']
    .map(period => demoConsumerReadApi.getHistory(market.id, period))))).filter(Boolean);
  const actorIds = [...new Set(histories.flatMap(history => history.actions.map(action => action.actorId)))];
  const profiles = (await Promise.all(actorIds.map(id => demoConsumerReadApi.getProfile(id)))).filter(Boolean);
  const leaderboards = await Promise.all(['7D', 'ALL'].map(period => demoConsumerReadApi.getLeaderboard(period)));
  const issues = auditConsumerSnapshot({ markets, histories, profiles, leaderboards });
  assert.deepEqual(issues, []);
  assert.ok(markets.length >= 10);
  assert.ok(histories.some(history => history.period === '1D' && history.series.some(series => series.points.length >= 24)));
});
