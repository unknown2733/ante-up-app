import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FreeRecord, MarketView, PublishedSnapshot } from '../../../contracts/types.ts';
import { createConsumerHistoryAdapter, historyGaps, SqliteFinalizedQuoteHistory } from '../src/consumer-history.ts';

const now = 1_800_000_000_000;
const market = { id: 'market-1', keyword: 'solana', phase: 'CURVE', price: { kind: 'curve', atoms: '1250000', executable: true } } as MarketView;
const snapshot = (sequence: string, atMs: number, nowQ12: string | null, d7Q12: string | null): PublishedSnapshot => ({
  finality: 'finalized', payloadHash: `hash-${sequence}`, payload: { marketId: market.id, sequence, dataThrough: atMs / 1000, dataStatus: 'VALID',
    activityNowQ12: nowQ12, activity7dQ12: d7Q12 },
} as PublishedSnapshot);
const firstAt = now - 45 * 60_000;
const snapshots = [snapshot('1', firstAt, '200', '100'), snapshot('2', now - 40 * 60_000, null, '100'), snapshot('3', now - 10 * 60_000, '300', '100')];
const record: FreeRecord = { id: 'record-1', wallet: 'wallet-1', marketId: market.id, direction: 'up', finality: 'finalized', proofId: null,
  entry: { executedAt: firstAt / 1000, slot: '1', signature: 'sig-1', snapshot: { marketId: market.id, sequence: '1', payloadHash: 'hash-1' }, h: null, unavailableReason: null },
  exit: { executedAt: (now - 10 * 60_000) / 1000, slot: '2', signature: 'sig-2', snapshot: { marketId: market.id, sequence: '3', payloadHash: 'hash-3' }, h: null, unavailableReason: null },
  status: 'CLOSED_RESULT', result: { kind: 'return', numerator: '1', denominator: '10' },
};
const adapter = createConsumerHistoryAdapter({
  namespace: 'devnet:program-1',
  market: async id => id === market.id ? market : null,
  snapshots: async () => snapshots,
  records: async () => [record],
  priceObservations: async () => [
    { id: 'curve-1', marketId: market.id, kind: 'CURVE_PRICE', atMs: firstAt, valueAtoms: '1000000', finality: 'finalized' },
    { id: 'curve-2', marketId: market.id, kind: 'CURVE_PRICE', atMs: now - 5 * 60_000, valueAtoms: '1250000', finality: 'finalized' },
    { id: 'other', marketId: 'other', kind: 'CURVE_PRICE', atMs: now - 2 * 60_000, valueAtoms: '9990000', finality: 'finalized' },
  ],
  nowMs: () => now,
});

test('projects only finalized evidence, separates curve from attention and free calls from fills', async () => {
  const result = await adapter.getHistory(market.id, '1D');
  assert.ok(result);
  assert.equal(result.source.mode, 'LIVE');
  assert.equal(result.market.latestPrice, '1.250000');
  assert.equal(result.market.changeFraction, null);
  assert.deepEqual(result.series.map(item => item.kind), ['CURVE_PRICE', 'ATTENTION_INDEX']);
  assert.deepEqual(result.series[0].points.map(point => point.value), ['1.000000', '1.250000']);
  assert.deepEqual(result.series[1].points.map(point => point.value), ['2.000000', '3.000000']);
  assert.equal(result.series[0].gaps.length, 3);
  assert.deepEqual(result.actions.map(action => action.kind), ['CALL_OPEN', 'CALL_CLOSE']);
  assert.deepEqual(result.actions.map(action => action.id), ['devnet:program-1:record-1:open', 'devnet:program-1:record-1:close']);
  assert.equal(result.actions[0].value, '2.000000');
  assert.equal(result.actions[1].returnFraction, 0.1);
  assert.equal(result.actions[0].recordId, record.id);
});

test('filters periods and never invents historical current quote points', async () => {
  const short = await adapter.getHistory(market.id, '1D');
  assert.ok(short);
  const empty = createConsumerHistoryAdapter({ namespace: 'devnet:program-1', market: async () => market, snapshots: async () => [], records: async () => [],
    priceObservations: async () => [], nowMs: () => now });
  const result = await empty.getHistory(market.id, '1W');
  assert.ok(result);
  assert.equal(result.market.latestPrice, '1.250000');
  assert.deepEqual(result.series, []);
  assert.deepEqual(result.actions, []);
  assert.equal(await adapter.getHistory('missing', 'ALL'), null);
});

test('marks collection gaps instead of joining distant points', () => {
  const points = [{ atMs: 100, value: '1' }, { atMs: 200, value: '2' }, { atMs: 1000, value: '3' }];
  assert.deepEqual(historyGaps(points, 0, 1200, 300), [
    { fromMs: 0, toMs: 100 }, { fromMs: 200, toMs: 1000 }, { fromMs: 1000, toMs: 1200 },
  ]);
});

test('note lookup receives the same canonical action ID as chart markers', async () => {
  const lookedUp: string[] = [];
  const noted = createConsumerHistoryAdapter({ namespace: 'devnet:program-1', market: async () => market,
    snapshots: async () => snapshots, records: async () => [record], priceObservations: async () => [], nowMs: () => now,
    noteForAction: async id => { lookedUp.push(id); return null; } });
  const result = await noted.getHistory(market.id, 'ALL');
  assert.deepEqual(lookedUp, result?.actions.map(action => action.id));
  assert.deepEqual(lookedUp, ['devnet:program-1:record-1:open', 'devnet:program-1:record-1:close']);
});

test('reads saved finalized-account quotes as spot history without inventing trade fills', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'au-chart-'));
  const path = join(dir, 'history.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE live_financial_quotes(cluster TEXT, program_id TEXT, quote_json TEXT)');
  const insert = db.prepare('INSERT INTO live_financial_quotes VALUES(?,?,?)');
  const quote = (id: string, action: string, phase: string, executable = true) => ({
    id, intent: { marketId: market.id, action }, chain: { cluster: 'devnet', programId: 'program-1', address: market.id },
    phase, executable, priceAtoms: '1250000', quotedAt: now / 1000,
  });
  insert.run('devnet', 'program-1', JSON.stringify(quote('curve', 'curveBuy', 'CURVE')));
  insert.run('devnet', 'program-1', JSON.stringify(quote('indexed', 'spotSell', 'INDEXED')));
  insert.run('devnet', 'program-1', JSON.stringify(quote('non-exec', 'curveBuy', 'CURVE', false)));
  insert.run('devnet', 'program-1', JSON.stringify(quote('not-fill', 'openPro', 'INDEXED')));
  insert.run('localnet', 'program-1', JSON.stringify(quote('wrong-cluster', 'curveBuy', 'CURVE')));
  db.close();
  const reader = new SqliteFinalizedQuoteHistory(path, 'devnet', 'program-1');
  try {
    const rows = await reader.priceObservations(market.id);
    assert.deepEqual(rows.map(row => row.kind), ['CURVE_PRICE', 'REFERENCE_PRICE']);
    assert.ok(rows.every(row => row.finality === 'finalized' && row.valueAtoms === '1250000'));
    assert.ok(rows.every(row => !row.id.includes('curve') && !row.id.includes('indexed')));
  } finally { reader.close(); rmSync(dir, { recursive: true, force: true }); }
});
