import assert from 'node:assert/strict';
import { auditConsumerSnapshot } from '../apps/web/qa/consumer/audit.mjs';

const base = (process.argv[2] ?? 'http://127.0.0.1:18787').replace(/\/$/, '');
const get = async (path) => {
  const response = await fetch(`${base}/v1/${path}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/, path);
  const envelope = await response.json();
  assert.equal(envelope.schemaVersion, '0.1');
  assert.equal(envelope.mode, 'devnet');
  assert.ok(Number.isSafeInteger(envelope.asOf));
  return envelope.data;
};
const markets = await get('consumer/markets');
assert.ok(Array.isArray(markets) && markets.length > 0);
assert.ok(markets.every(m => m.source.mode === 'LIVE' && !m.id.startsWith('demo:')));
const histories = [];
for (const market of markets.slice(0, 8)) {
  for (const period of ['1D', '1W', 'ALL']) {
    const history = await get(`consumer/markets/${encodeURIComponent(market.id)}/history?period=${period}`);
    assert.equal(history.market.id, market.id);
    assert.equal(history.period, period);
    histories.push(history);
  }
}
const boards = [await get('consumer/leaderboard?period=7D'), await get('consumer/leaderboard?period=ALL')];
const actorIds = [...new Set(histories.flatMap(h => h.actions.map(a => a.actorId)))].slice(0, 8);
const profiles = [];
for (const actor of actorIds) profiles.push(await get(`consumer/profiles/${encodeURIComponent(actor)}`));
const action = histories.flatMap(h => h.actions)[0];
if (action) {
  const note = await get(`consumer/notes/${encodeURIComponent(action.id)}`);
  assert.ok(Array.isArray(note.revisions));
  const rejected = await fetch(`${base}/v1/consumer/notes/${encodeURIComponent(action.id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: action.actorId, body: 'Unauthorized verification probe', expectedVersion: 0 }),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok([401,403].includes(rejected.status), 'unauthenticated note write must fail');
}
const invalid = await fetch(`${base}/v1/consumer/leaderboard?period=INVALID`, { signal: AbortSignal.timeout(30000) });
assert.equal(invalid.status, 400);
const issues = auditConsumerSnapshot({ markets, histories, profiles, leaderboards: boards });
assert.deepEqual(issues, []);
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), markets: markets.map(m => ({ id: m.id, title: m.title, mode: m.source.mode })),
  histories: histories.map(h => ({ marketId: h.market.id, period: h.period, actions: h.actions.length,
    series: h.series.map(s => ({ kind: s.kind, points: s.points.length, last: s.points.at(-1) ?? null })) })),
  profiles: profiles.length, leaderboardPeriods: boards.map(b => b.period), findings: issues,
  noteUnauthorizedRejected: !!action, financialWrites: 0 }, null, 2));
