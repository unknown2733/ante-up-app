import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => server.close());
const { createLiveConsumerHttp } = await server.ssrLoadModule('/src/consumerHttp.ts');
const envelope = (data, nextCursor = null) => ({ schemaVersion: '0.1', mode: 'devnet', asOf: 1_700_000_000, nextCursor, data });

test('consumer reads use the versioned public endpoints without credentials', async () => {
  const calls = [];
  const client = createLiveConsumerHttp('/api', async (url, init) => {
    calls.push({ url, init });
    return Response.json(envelope([]));
  });
  await client.read.listMarkets();
  await client.read.getHistory('market/one', '1W');
  await client.read.getProfile('wallet/one');
  await client.read.getLeaderboard('ALL');
  assert.deepEqual(calls.map(call => call.url), [
    '/api/v1/consumer/markets',
    '/api/v1/consumer/markets/market%2Fone/history?period=1W',
    '/api/v1/consumer/profiles/wallet%2Fone',
    '/api/v1/consumer/leaderboard?period=ALL',
  ]);
  assert.ok(calls.every(call => call.init.cache === 'no-store' && !('Authorization' in call.init.headers)));
});

test('notes read publicly and write with the existing bearer token and version', async () => {
  const calls = [];
  const note = { id: 'note:one', version: 2 };
  const client = createLiveConsumerHttp('/api/', async (url, init) => {
    calls.push({ url, init });
    return Response.json(envelope(init.method === 'PUT' ? { note } : { note, revisions: [] }));
  });
  assert.deepEqual(await client.getNote('action:one'), { note, revisions: [] });
  assert.deepEqual(await client.saveNote('action:one', 'wallet', 'Updated call', 1, 'token'), note);
  assert.equal(calls[0].url, '/api/v1/consumer/notes/action%3Aone');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer token');
  assert.deepEqual(JSON.parse(calls[1].init.body), { wallet: 'wallet', body: 'Updated call', expectedVersion: 1 });
});

test('a fixture-mode envelope cannot masquerade as Live Devnet', async () => {
  const client = createLiveConsumerHttp('/api', async () => Response.json({ ...envelope([]), mode: 'fixture' }));
  await assert.rejects(client.read.listMarkets(), /envelope or network is invalid/);
});

test('markets, profile actions and ranks follow cursors without dropping later pages', async () => {
  const calls = [];
  const profile = { actorId: 'wallet', actions: [{ id: 'first' }] };
  const board = { period: 'ALL', rows: [{ actorId: 'first' }] };
  const client = createLiveConsumerHttp('/api', async url => {
    calls.push(url);
    const second = url.includes('cursor=next');
    const data = url.includes('/profiles/') ? { ...profile, actions: [{ id: second ? 'second' : 'first' }] }
      : url.includes('/leaderboard') ? { ...board, rows: [{ actorId: second ? 'second' : 'first' }] }
      : [{ id: second ? 'second' : 'first' }];
    return Response.json(envelope(data, second ? null : 'next'));
  });
  assert.deepEqual((await client.read.listMarkets()).map(row => row.id), ['first', 'second']);
  assert.deepEqual((await client.read.getProfile('wallet')).actions.map(row => row.id), ['first', 'second']);
  assert.deepEqual((await client.read.getLeaderboard('ALL')).rows.map(row => row.actorId), ['first', 'second']);
  assert.equal(calls.filter(url => url.includes('cursor=next')).length, 3);
});

test('repeated cursors fail visibly instead of presenting a partial result', async () => {
  const client = createLiveConsumerHttp('/api', async () => Response.json(envelope([], 'same')));
  await assert.rejects(client.read.listMarkets(), /repeated a cursor/);
});
