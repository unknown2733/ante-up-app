import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { getBase58Decoder } from '@solana/kit';
import { consumerFreeActionId, consumerLiveNamespace } from '../../../contracts/consumer-identity.ts';
import type { ConsumerReadApi } from '../../../contracts/consumer.ts';
import type { FreeRecord, MarketView } from '../../../contracts/types.ts';
import { createApp } from '../src/app.ts';
import { createConsumerHistoryAdapter, projectConsumerMarket } from '../src/consumer-history.ts';
import { ConsumerNoteService, createConsumerSocialProjection, createFinalizedFreeActionLookup, SqliteNotePersistence } from '../src/consumer-social.ts';
import { LiveStore } from '../src/live-store.ts';
import { createApiServer } from '../src/server.ts';

const now = 1_800_000_000;
const programId = '1'.repeat(32);
const key = () => getBase58Decoder().decode(generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const marketId = key();
const wallet = key();
const otherWallet = key();
const namespace = consumerLiveNamespace('devnet', programId);
const market = { id: marketId, keyword: 'solana', phase: 'CURVE',
  price: { kind: 'curve', atoms: '1000000', executable: true } } as MarketView;
const point = (executedAt: number) => ({ executedAt, slot: '1', signature: 'sig', snapshot: null, h: null, unavailableReason: null });
const record: FreeRecord = { id: 'Record123', wallet, marketId, direction: 'up', entry: point(now - 100),
  exit: point(now - 50), status: 'CLOSED_RESULT', result: { kind: 'return', numerator: '1', denominator: '10' },
  finality: 'finalized', proofId: null };
const response = async (result: Response) => result.json() as Promise<any>;

test('actual consumer HTTP reads and authenticated note writes share Envelope and canonical action IDs', async () => {
  const records = async () => [record];
  const notes = new SqliteNotePersistence(':memory:');
  const liveStore = new LiveStore(':memory:');
  const history = createConsumerHistoryAdapter({ namespace, market: async id => id === marketId ? market : null,
    snapshots: async () => [], records: async () => [record], priceObservations: async () => [], nowMs: () => now * 1000,
    noteForAction: actionId => notes.read(actionId) });
  const social = createConsumerSocialProjection({ records, heldWallets: async () => new Set(), notes, namespace,
    clockMs: () => now * 1000 });
  const consumerRead: ConsumerReadApi = {
    listMarkets: async () => [projectConsumerMarket(market, now * 1000)],
    getHistory: history.getHistory, getProfile: social.getProfile, getLeaderboard: social.getLeaderboard,
  };
  const read = { mode: 'devnet' as const, markets: async () => [market], records,
    proofs: async () => [], heldCalculationWallets: async () => new Set<string>() };
  const consumer = { read: consumerRead, namespace,
    notes: new ConsumerNoteService(createFinalizedFreeActionLookup(records, namespace), notes, () => now * 1000) };
  assert.throws(() => createApp({ mode: 'localnet', programId, read: { ...read, mode: 'localnet' }, liveStore,
    chain: { async get() { return null; }, async discover() { return []; } }, consumer }), /CONSUMER_DEVNET_ONLY/);
  assert.throws(() => createApp({ mode: 'devnet', programId, read, liveStore,
    chain: { async get() { return null; }, async discover() { return []; } },
    consumer: { ...consumer, namespace: consumerLiveNamespace('devnet', 'OtherProgram') } }), /CONSUMER_NAMESPACE_MISMATCH/);
  const app = createApp({ mode: 'devnet', programId, read, liveStore, now: () => now,
    chain: { async get() { return null; }, async discover() { return []; } },
    verifier: { async verify() { return true; } },
    consumer });
  const server = createApiServer(app);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const get = (path: string) => fetch(base + path);
    const expected = { schemaVersion: '0.1', mode: 'devnet', asOf: now, nextCursor: null };
    for (const path of ['/v1/consumer/markets', '/v1/consumer/markets/' + marketId + '/history?period=1W',
      '/v1/consumer/profiles/' + wallet, '/v1/consumer/leaderboard?period=7D']) {
      const result = await get(path);
      assert.equal(result.status, 200, path);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      const body = await response(result);
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(body[key], value, path + ' ' + key);
    }
    const historyBody = await response(await get('/v1/consumer/markets/' + marketId + '/history?period=ALL'));
    const actionId = consumerFreeActionId(namespace, record.id, 'open');
    assert.equal(historyBody.data.actions[0].id, actionId);
    assert.equal(historyBody.data.series.length, 0);
    const profileBody = await response(await get('/v1/consumer/profiles/' + wallet));
    assert.equal(profileBody.data.actions.find((action: any) => action.kind === 'CALL_OPEN').id, actionId);
    const board = await response(await get('/v1/consumer/leaderboard?period=ALL'));
    assert.equal(board.data.rows[0].meanReturnFraction, 0.1);
    assert.equal((await get('/v1/consumer/leaderboard?period=1D')).status, 400);
    assert.equal((await get('/v1/consumer/markets/' + marketId + '/history?period=7D')).status, 400);
    assert.equal((await get('/v1/consumer/markets?limit=101')).status, 400);
    assert.equal((await get('/v1/consumer/profiles/%ZZ')).status, 400);
    assert.equal((await get('/v1/consumer/notes/bad-id')).status, 400);
    const notePath = '/v1/consumer/notes/' + encodeURIComponent(actionId);
    const before = await response(await get(notePath));
    assert.deepEqual(before.data, { note: null, revisions: [] });
    const put = (owner: string, bearer: string | null, expectedVersion: number, body = 'I expected a rise') =>
      fetch(base + notePath, { method: 'PUT', headers: bearer ? { authorization: 'Bearer ' + bearer } : {},
        body: JSON.stringify({ wallet: owner, body, expectedVersion }) });
    assert.equal((await put(wallet, null, 0)).status, 403);
    const challenge = await response(await fetch(base + '/v1/auth', { method: 'POST',
      body: JSON.stringify({ wallet, cluster: 'devnet' }) }));
    const session = await response(await fetch(base + '/v1/auth/session', { method: 'POST',
      body: JSON.stringify({ wallet, cluster: 'devnet', nonce: challenge.data.nonce, signature: 'test' }) }));
    const token = session.data.token as string;
    assert.equal((await put(otherWallet, token, 0)).status, 403);
    const saved = await response(await put(wallet, token, 0));
    assert.equal(saved.data.note.version, 1);
    assert.equal(saved.data.note.timing, 'ADDED_LATER');
    assert.equal(saved.data.note.proofCoverage, 'NONE');
    assert.equal((await put(wallet, token, 0)).status, 409);
    const edited = await response(await put(wallet, token, 1, 'I changed my view'));
    assert.equal(edited.data.note.version, 2);
    const after = await response(await get(notePath));
    assert.deepEqual(after.data.revisions.map((item: any) => item.body), ['I expected a rise', 'I changed my view']);
    const linked = await response(await get('/v1/consumer/markets/' + marketId + '/history?period=ALL'));
    assert.equal(linked.data.actions[0].note.body, 'I changed my view');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    liveStore.close(); notes.close();
  }
});
