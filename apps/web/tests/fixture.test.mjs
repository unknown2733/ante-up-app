import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
};
const server = await createServer({ optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { fixtureApi } = await server.ssrLoadModule('/src/fixture.ts');
const wallet = 'demo:you';

test('fixture uses the v0.1 envelope and exposes explicit market states', async () => {
  const response = await fixtureApi.listMarkets();
  assert.equal(response.schemaVersion, '0.1');
  assert.equal(response.mode, 'fixture');
  assert.deepEqual(new Set(response.data.map((market) => market.dataStatus)), new Set(['VALID', 'LOW_ACTIVITY', 'OUTAGE', 'PREPARING']));
  assert.ok(response.data.every((market) => market.price === null || market.price.executable === false));
});

test('one open chip per market, three concurrent, and outage close stays N/A', async () => {
  memory.clear();
  assert.equal((await fixtureApi.openFree(wallet, 'm-attention')).kind, 'notExecutable');
  const meme = await fixtureApi.openFree(wallet, 'm-meme');
  const outage = await fixtureApi.openFree(wallet, 'm-outage');
  assert.equal(meme.kind, 'fixture');
  assert.equal(outage.kind, 'fixture');
  assert.equal((await fixtureApi.openFree(wallet, 'm-signal')).kind, 'notExecutable');
  const closed = await fixtureApi.closeFree(wallet, outage.record.id);
  assert.equal(closed.kind, 'fixture');
  assert.equal(closed.record.status, 'CLOSED_NA');
  assert.equal(closed.record.result.kind, 'na');
  assert.equal((await fixtureApi.closeFree(wallet, outage.record.id)).kind, 'notExecutable');
  const profile = (await fixtureApi.getProfile(wallet)).data;
  assert.equal(profile.openRecords.length, 2);
  assert.equal(profile.closedNaCount, '2');
  assert.equal(profile.closedRecords.filter((record) => record.id === outage.record.id).length, 1);
});

test('proof and ranking states distinguish pending, invalid, replaced and joint rank', async () => {
  assert.equal((await fixtureApi.getProof('proof-loss')).data.state, 'CONFIRMING');
  assert.equal((await fixtureApi.getProof('proof-invalid')).data.state, 'INVALID');
  assert.equal((await fixtureApi.getProof('proof-replaced')).data.replacementId, 'proof-new');
  const page = (await fixtureApi.getLeaderboard('7d')).data;
  assert.equal(page.rows[0].rank, page.rows[1].rank);
  assert.deepEqual(page.heldWallets, ['demo:held']);
  assert.equal(page.rows.every((row) => row.status === 'ELIGIBLE'), true);
  assert.equal((await fixtureApi.getProof('proof-na')).data.payloadHash, null);
  assert.equal((await fixtureApi.getProof('proof-na')).data.manifestRef, null);
});

test.after(async () => { await server.close(); });
